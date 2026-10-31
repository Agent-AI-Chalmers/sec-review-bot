"""Agent calls own MCP capabilities and sessions, including exceptional exits."""

import asyncio
from contextlib import asynccontextmanager
from importlib import import_module
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from deepagents.backends.protocol import BackendProtocol

from sec_review_agents.mcp import resolver
from sec_review_agents.runtime import agent_runtime_graph


@pytest.fixture(params=["analysis", "mitigation", "verification", "single_agent"])
def agent_call(request, monkeypatch, tmp_path: Path):
    role = request.param
    module = import_module(f"sec_review_agents.agents.{role}.agent")
    backend = Mock(spec=BackendProtocol)
    backend.close = Mock()
    backend.aclose = AsyncMock()
    monkeypatch.setenv("AGENT_MCP_ENABLED", "true")
    monkeypatch.setattr(module, "create_chat_model", Mock())
    monkeypatch.setattr(module, "create_summarization_middleware", Mock())
    monkeypatch.setattr(module, "create_filesystem_middleware", Mock())
    monkeypatch.setattr(module, "agent_skills_enabled", lambda: False)
    monkeypatch.setattr(module, "model_turn_diagnostics_enabled", lambda: False)

    def connection(name, supplied_backend):
        assert supplied_backend is backend
        return {name: {"transport": "stdio", "command": name}}

    monkeypatch.setattr(
        resolver,
        "codegraph_mcp_connections_for_backend",
        lambda backend: connection("codegraph", backend),
    )
    monkeypatch.setattr(
        resolver,
        "playwright_mcp_connections_for_backend",
        lambda backend: connection("playwright", backend),
    )
    kwargs = {
        "agent_name": f"test-{role}",
        "backend": backend,
        "system_prompt": "system",
        "filesystem_system_prompt": "filesystem",
        "user_prompt": "review",
        "trajectory_paths": (tmp_path / "trajectory.jsonl",),
        "memory_enabled": False,
    }
    if role in {"mitigation", "single_agent"}:
        kwargs.update(
            baseline_snapshot_tar_path=tmp_path / "baseline.tar",
            workspace_root_path=tmp_path,
        )
    if role == "single_agent":
        kwargs.update(todo_system_prompt="todo", todo_tool_description="plan")
    name = "single" if role == "single_agent" else role
    return SimpleNamespace(
        module=module,
        run=getattr(module, f"run_{name}_agent"),
        kwargs=kwargs,
        servers=(
            ["codegraph", "playwright"] if role == "verification" else ["codegraph"]
        ),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "outcome", ["success", "build-error", "invoke-error", "cancel"]
)
async def test_agent_owns_sessions_through_build_and_invocation(
    agent_call, monkeypatch, outcome: str
) -> None:
    """Neither graph construction nor invocation failure may strand a live session."""
    events = []
    sessions = []
    entered_invocation = asyncio.Event()

    class Client:
        def __init__(self, connections, *, tool_name_prefix):
            assert list(connections) == agent_call.servers
            assert tool_name_prefix is True

        @asynccontextmanager
        async def session(self, server_name):
            session = SimpleNamespace(name=server_name, active=True, calls=0)
            sessions.append(session)
            events.append(f"open:{server_name}")
            try:
                yield session
            finally:
                session.active = False
                events.append(f"close:{server_name}")

    async def load_tools(session, *, server_name, tool_name_prefix):
        assert session.active
        assert server_name == session.name

        async def call():
            assert session.active
            session.calls += 1
            return session.calls

        return [call]

    async def build(**kwargs):
        assert all(session.active for session in sessions)
        assert len(kwargs["tools"]) == len(agent_call.servers)
        events.append("build")
        if outcome == "build-error":
            raise RuntimeError("build failed")
        return SimpleNamespace(tools=kwargs["tools"])

    async def invoke(**kwargs):
        assert kwargs["user_prompt"] == agent_call.kwargs["user_prompt"]
        assert kwargs["trajectory_paths"] == agent_call.kwargs["trajectory_paths"]
        events.append("invoke")
        for tool in kwargs["agent"].tools:
            assert await tool() == 1
            assert await tool() == 2
        entered_invocation.set()
        if outcome == "invoke-error":
            raise RuntimeError("invoke failed")
        if outcome == "cancel":
            await asyncio.Event().wait()
        return Mock(model_dump=Mock(return_value={"overview": "done"}))

    monkeypatch.setattr("langchain_mcp_adapters.client.MultiServerMCPClient", Client)
    monkeypatch.setattr("langchain_mcp_adapters.tools.load_mcp_tools", load_tools)
    monkeypatch.setattr(agent_runtime_graph, "build_agent_runtime_graph", build)
    monkeypatch.setattr(agent_runtime_graph, "invoke_agent_runtime_graph", invoke)

    if outcome == "cancel":
        task = asyncio.create_task(agent_call.run(**agent_call.kwargs))
        await asyncio.wait_for(entered_invocation.wait(), timeout=5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    elif outcome.endswith("error"):
        with pytest.raises(RuntimeError, match=outcome.replace("-error", " failed")):
            await agent_call.run(**agent_call.kwargs)
    else:
        assert await agent_call.run(**agent_call.kwargs) == {"overview": "done"}

    assert not any(session.active for session in sessions)
    assert events == [
        *[f"open:{server}" for server in agent_call.servers],
        "build",
        *([] if outcome == "build-error" else ["invoke"]),
        *[f"close:{server}" for server in reversed(agent_call.servers)],
    ]
    # The borrowed backend remains the stage's resource, even on cancellation.
    agent_call.kwargs["backend"].close.assert_not_called()
    agent_call.kwargs["backend"].aclose.assert_not_called()


@pytest.mark.asyncio
async def test_disabled_mcp_runs_agent_without_connecting(
    agent_call, monkeypatch
) -> None:
    monkeypatch.setenv("AGENT_MCP_ENABLED", "false")
    client = Mock(side_effect=AssertionError("MCP must stay disabled"))
    monkeypatch.setattr("langchain_mcp_adapters.client.MultiServerMCPClient", client)

    async def build(**kwargs):
        assert kwargs["tools"] == []
        return object()

    async def invoke(**kwargs):
        return Mock(model_dump=Mock(return_value={"overview": "done"}))

    monkeypatch.setattr(agent_runtime_graph, "build_agent_runtime_graph", build)
    monkeypatch.setattr(agent_runtime_graph, "invoke_agent_runtime_graph", invoke)
    assert await agent_call.run(**agent_call.kwargs) == {"overview": "done"}
    client.assert_not_called()
