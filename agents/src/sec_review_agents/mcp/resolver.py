import asyncio
from collections.abc import Callable
from typing import Any

from sec_review_agents.features import agent_mcp_enabled
from sec_review_agents.mcp.codegraph import codegraph_mcp_connections_for_backend
from sec_review_agents.mcp.playwright import playwright_mcp_connections_for_backend

CODEGRAPH_MCP_TOOL = "codegraph"
PLAYWRIGHT_MCP_TOOL = "playwright"

_AGENT_MCP_CONNECTIONS: dict[str, Callable[[Any], dict[str, Any]]] = {
    CODEGRAPH_MCP_TOOL: codegraph_mcp_connections_for_backend,
    PLAYWRIGHT_MCP_TOOL: playwright_mcp_connections_for_backend,
}


async def _prepare_connection(
    builder: Callable[[Any], dict[str, Any]], backend: Any
) -> dict[str, Any]:
    # Cancelling to_thread does not stop its worker. Keep ownership until it exits.
    task = asyncio.create_task(asyncio.to_thread(builder, backend))
    cancellation = None
    while not task.done():
        try:
            await asyncio.wait({task})
        except asyncio.CancelledError as error:
            cancellation = error
    if cancellation is not None:
        if not task.cancelled():
            task.exception()  # Retrieve a worker failure without replacing cancellation.
        raise cancellation
    return task.result()


async def resolve_agent_mcp_connections(
    tool_names: tuple[str, ...],
    backend: Any,
) -> dict[str, Any]:
    # This is an allowlist resolver, not MCP discovery. Agent declarations name
    # project-owned integrations; each name must map to explicit code. Unknown
    # names fail even when MCP is globally disabled.
    builders = []
    for tool_name in tool_names:
        builder = _AGENT_MCP_CONNECTIONS.get(tool_name)
        if builder is None:
            raise ValueError(f"Unknown agent MCP tool: {tool_name}")
        builders.append(builder)
    if not agent_mcp_enabled():
        return {}
    # Preparations are independent. Unlike TaskGroup, gather re-raises the
    # builder's own error; the remaining preparations are cancelled explicitly.
    tasks = [
        asyncio.create_task(_prepare_connection(builder, backend))
        for builder in builders
    ]
    try:
        results = await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            task.cancel()
        cleanup = asyncio.gather(*tasks, return_exceptions=True)
        cancellation = None
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError as error:
                cancellation = error
        cleanup.result()
        if cancellation is not None:
            raise cancellation
        raise
    connections: dict[str, Any] = {}
    for result in results:
        connections.update(result)
    return connections
