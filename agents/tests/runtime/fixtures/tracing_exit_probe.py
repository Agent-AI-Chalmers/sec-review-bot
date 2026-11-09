"""Verify SDK exit delivery in a process that never explicitly flushes tracing."""

import asyncio
import os
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import TypedDict

from langfuse import Langfuse
from langgraph.graph import END, START, StateGraph
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from pydantic import BaseModel

from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph


class Exporter(SpanExporter):
    def __init__(self, output: Path) -> None:
        self.output = output
        self.returned = output.with_suffix(".returned")

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        assert (
            self.returned.exists()
        ), "Export must not be forced before the review returns."
        self.output.write_text(str(len(spans)), encoding="utf-8")
        return SpanExportResult.SUCCESS

    def shutdown(self) -> None:
        pass


class Output(BaseModel):
    status: str


class ProbeState(TypedDict, total=False):
    messages: list[object]
    structured_response: Output


def main() -> None:
    output = Path(sys.argv[1])
    os.environ.update(
        LANGFUSE_PUBLIC_KEY="pk-exit-test",
        LANGFUSE_SECRET_KEY="sk-exit-test",
        LANGFUSE_BASE_URL="https://langfuse.invalid",
    )
    Langfuse(
        tracer_provider=TracerProvider(),
        span_exporter=Exporter(output),
        flush_at=512,
        flush_interval=3600,
    )
    graph = StateGraph(ProbeState)
    graph.add_node("model", lambda state: {"structured_response": Output(status="ok")})
    graph.add_edge(START, "model")
    graph.add_edge("model", END)
    result = asyncio.run(
        invoke_agent_runtime_graph(
            agent=graph.compile(),
            response_format=Output,
            agent_name="exit-test",
            user_prompt="prompt",
        )
    )
    assert result.status == "ok"
    assert not output.exists(), "Trace batch should still be queued."
    output.with_suffix(".returned").write_text("ok", encoding="utf-8")


if __name__ == "__main__":
    main()
