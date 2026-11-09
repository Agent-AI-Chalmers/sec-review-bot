"""Exercise runtime delivery boundaries with the real Langfuse batch processor."""

import asyncio
import subprocess
import sys
from collections.abc import Iterator, Sequence
from pathlib import Path
from threading import Event
from typing import TypedDict
from unittest.mock import Mock
from uuid import uuid4

import pytest
from langfuse import Langfuse
from langfuse.langchain import CallbackHandler
from langgraph.graph import END, START, StateGraph
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from pydantic import BaseModel

from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph


class ProbeOutput(BaseModel):
    status: str


class ProbeState(TypedDict, total=False):
    messages: list[object]
    structured_response: ProbeOutput


class ControlledExporter(SpanExporter):
    def __init__(self) -> None:
        self.started = Event()
        self.release = Event()
        self.finished = Event()
        self.release.set()
        self.fail = False
        self.spans: list[ReadableSpan] = []

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        self.started.set()
        try:
            if not self.release.wait(timeout=5):
                raise TimeoutError("Test did not release the exporter.")
            if self.fail:
                raise RuntimeError("Exporter unavailable.")
            self.spans.extend(spans)
            return SpanExportResult.SUCCESS
        finally:
            self.finished.set()

    def shutdown(self) -> None:
        return None


@pytest.fixture
def tracing_delivery(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[tuple[Langfuse, ControlledExporter]]:
    public_key = f"pk-test-{uuid4().hex}"
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", public_key)
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test")
    monkeypatch.setenv("LANGFUSE_BASE_URL", "https://langfuse.invalid")
    exporter = ControlledExporter()
    provider = TracerProvider(shutdown_on_exit=False)
    client = Langfuse(
        public_key=public_key,
        secret_key="sk-test",
        base_url="https://langfuse.invalid",
        tracer_provider=provider,
        span_exporter=exporter,
        flush_at=1,
    )
    monkeypatch.setattr("langfuse.Langfuse", lambda **kwargs: client)
    monkeypatch.setattr(
        "langfuse.langchain.CallbackHandler",
        lambda: CallbackHandler(public_key=public_key),
    )
    try:
        yield client, exporter
    finally:
        exporter.release.set()
        client.shutdown()
        provider.shutdown()


@pytest.mark.asyncio
async def test_agent_returns_while_tracing_export_is_blocked(
    tracing_delivery, tmp_path: Path
) -> None:
    """A remote exporter must not hold the event loop or delay a completed review."""
    _client, exporter = tracing_delivery
    exporter.release.clear()
    graph = StateGraph(ProbeState)
    graph.add_node(
        "model", lambda state: {"structured_response": ProbeOutput(status="ok")}
    )
    graph.add_edge(START, "model")
    graph.add_edge("model", END)

    result = await asyncio.wait_for(
        invoke_agent_runtime_graph(
            agent=graph.compile(),
            response_format=ProbeOutput,
            agent_name="test-agent",
            user_prompt="prompt",
            trajectory_paths=(tmp_path / "trajectory.jsonl",),
        ),
        timeout=2,
    )
    assert await asyncio.to_thread(exporter.started.wait, 2)
    assert result == ProbeOutput(status="ok")
    assert not exporter.finished.is_set()
    exporter.release.set()
    assert await asyncio.to_thread(exporter.finished.wait, 2)
    assert exporter.spans


@pytest.mark.asyncio
async def test_export_failure_does_not_fail_successful_agent(tracing_delivery) -> None:
    client, exporter = tracing_delivery
    exporter.fail = True
    # A manual flush must not run in the invocation's cleanup path, either.
    client.flush = Mock(side_effect=RuntimeError("Manual flush failed."))
    graph = StateGraph(ProbeState)
    graph.add_node(
        "model", lambda state: {"structured_response": ProbeOutput(status="ok")}
    )
    graph.add_edge(START, "model")
    graph.add_edge("model", END)

    result = await invoke_agent_runtime_graph(
        agent=graph.compile(),
        response_format=ProbeOutput,
        agent_name="test-agent",
        user_prompt="prompt",
    )
    assert await asyncio.to_thread(exporter.finished.wait, 2)
    assert result.status == "ok"


@pytest.mark.asyncio
async def test_tracing_cleanup_preserves_original_agent_error(tracing_delivery) -> None:
    client, _exporter = tracing_delivery
    client.flush = Mock(side_effect=RuntimeError("Manual flush failed."))
    error = ValueError("Agent failed.")

    def fail(state):
        raise error

    graph = StateGraph(ProbeState)
    graph.add_node("model", fail)
    graph.add_edge(START, "model")
    graph.add_edge("model", END)
    with pytest.raises(ValueError) as captured:
        await invoke_agent_runtime_graph(
            agent=graph.compile(),
            response_format=ProbeOutput,
            agent_name="test-agent",
            user_prompt="prompt",
        )
    assert captured.value is error


@pytest.mark.asyncio
async def test_tracing_cleanup_preserves_agent_cancellation(tracing_delivery) -> None:
    client, _exporter = tracing_delivery
    client.flush = Mock(side_effect=RuntimeError("Manual flush failed."))
    started = asyncio.Event()

    async def wait(state):
        started.set()
        await asyncio.Event().wait()

    graph = StateGraph(ProbeState)
    graph.add_node("model", wait)
    graph.add_edge(START, "model")
    graph.add_edge("model", END)
    task = asyncio.create_task(
        invoke_agent_runtime_graph(
            agent=graph.compile(),
            response_format=ProbeOutput,
            agent_name="test-agent",
            user_prompt="prompt",
        )
    )
    try:
        await asyncio.wait_for(started.wait(), timeout=2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


def test_normal_process_exit_delivers_queued_traces(tmp_path: Path) -> None:
    """Short-lived CLI processes rely on SDK exit cleanup after the review returns."""
    output = tmp_path / "exported.txt"
    probe = Path(__file__).parent / "fixtures" / "tracing_exit_probe.py"
    completed = subprocess.run(
        [sys.executable, str(probe), str(output)],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert int(output.read_text()) > 0
