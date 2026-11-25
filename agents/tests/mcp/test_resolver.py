import asyncio
import threading
import time

import pytest
from deepagents.backends.protocol import ExecuteResponse

from sec_review_agents.filesystem.docker_backend import (
    DockerRoute,
    DockerSandboxBackend,
)
from sec_review_agents.filesystem.docker_runtime import DockerContainerResource
from sec_review_agents.mcp.resolver import resolve_agent_mcp_connections


def _docker_backend() -> DockerSandboxBackend:
    container = DockerContainerResource(
        container_name="test-container",
        image="test-image:latest",
        shell="/bin/sh",
        start_command="while true; do sleep 3600; done",
        mounts=[],
        working_directory="/workspace",
        environment={},
        auto_remove=True,
        network_mode="none",
        user=None,
        timeout_ms=None,
    )
    return DockerSandboxBackend(
        container=container,
        routes=[
            DockerRoute(
                container_path="/mnt/material/workspace",
                agent_path="/workspace",
                writable=True,
            )
        ],
    )


@pytest.mark.asyncio
async def test_mcp_connections_resolve_declared_codegraph_tool(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_MCP_ENABLED", "true")
    backend = object()
    calls = []

    def fake_codegraph_connections(received_backend):
        calls.append(received_backend)
        return {"codegraph": {"transport": "stdio"}}

    monkeypatch.setattr(
        "sec_review_agents.mcp.resolver.codegraph_mcp_connections_for_backend",
        fake_codegraph_connections,
    )

    connections = await resolve_agent_mcp_connections(("codegraph",), backend)

    assert connections == {"codegraph": {"transport": "stdio"}}
    assert calls == [backend]


@pytest.mark.asyncio
async def test_mcp_connections_resolve_declared_playwright_tool(
    monkeypatch,
) -> None:
    monkeypatch.setenv("AGENT_MCP_ENABLED", "true")
    backend = object()
    calls = []

    def fake_playwright_connections(received_backend):
        calls.append(received_backend)
        return {"playwright": {"transport": "stdio"}}

    monkeypatch.setattr(
        "sec_review_agents.mcp.resolver.playwright_mcp_connections_for_backend",
        fake_playwright_connections,
    )

    connections = await resolve_agent_mcp_connections(("playwright",), backend)

    assert connections == {"playwright": {"transport": "stdio"}}
    assert calls == [backend]


@pytest.mark.asyncio
async def test_mcp_connections_reject_unknown_tool() -> None:
    with pytest.raises(ValueError, match="Unknown agent MCP tool: osv"):
        await resolve_agent_mcp_connections(("osv",), object())


@pytest.mark.asyncio
async def test_mcp_connections_global_disable_skips_resolution(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_MCP_ENABLED", "false")

    connections = await resolve_agent_mcp_connections(("codegraph",), object())

    assert connections == {}


@pytest.mark.asyncio
async def test_mcp_connections_global_disable_still_rejects_unknown_tool(
    monkeypatch,
) -> None:
    monkeypatch.setenv("AGENT_MCP_ENABLED", "false")

    with pytest.raises(ValueError, match="Unknown agent MCP tool: osv"):
        await resolve_agent_mcp_connections(("osv", "codegraph"), object())


@pytest.mark.asyncio
async def test_mcp_connection_preparation_does_not_block_the_event_loop(
    monkeypatch,
) -> None:
    """Agent runners await MCP preparation on their event loop.

    CodeGraph indexing can take minutes; a blocking call there stalls every other
    task on the loop, including activity heartbeats, and delays cancellation.
    """
    monkeypatch.setenv("AGENT_MCP_ENABLED", "true")
    backend = _docker_backend()
    command_seconds = 0.3

    def blocking_execute(command, *, timeout=None):
        time.sleep(command_seconds)
        return ExecuteResponse(output="unavailable", exit_code=1)

    async def awaiting_execute(command, *, timeout=None):
        await asyncio.sleep(command_seconds)
        return ExecuteResponse(output="unavailable", exit_code=1)

    monkeypatch.setattr(backend.container, "ensure_started", lambda: None)
    monkeypatch.setattr(backend, "execute", blocking_execute)
    monkeypatch.setattr(backend, "aexecute", awaiting_execute)

    ticks = 0

    async def ticker() -> None:
        nonlocal ticks
        while True:
            await asyncio.sleep(0.02)
            ticks += 1

    ticker_task = asyncio.create_task(ticker())
    try:
        connections = await resolve_agent_mcp_connections(
            ("codegraph", "playwright"), backend
        )
    finally:
        ticker_task.cancel()

    assert connections == {}
    # Two commands of 0.3 s each leave room for ~30 ticks; a blocked loop allows ~0.
    assert ticks >= 10


@pytest.mark.asyncio
@pytest.mark.parametrize("fails", [False, True])
async def test_cancellation_waits_for_worker_completion(monkeypatch, fails):
    """Repeated cancellation must not abandon a worker using backend resources.

    A worker failure during cancellation must not replace CancelledError.
    """
    monkeypatch.setenv("AGENT_MCP_ENABLED", "true")
    backend = _docker_backend()
    started, release, finished = [threading.Event() for _ in range(3)]

    def execute(command, *, timeout=None):
        started.set()
        try:
            assert release.wait(5)
            if fails:
                raise RuntimeError("preparation failed")
            return ExecuteResponse(output="unavailable", exit_code=1)
        finally:
            finished.set()

    monkeypatch.setattr(backend.container, "ensure_started", lambda: None)
    monkeypatch.setattr(backend, "execute", execute)
    task = asyncio.create_task(resolve_agent_mcp_connections(("codegraph",), backend))
    try:
        assert await asyncio.to_thread(started.wait, 5)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert finished.is_set()
