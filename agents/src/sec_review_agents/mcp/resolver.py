import asyncio
from collections.abc import Callable
from typing import Any

from sec_review_agents.features import agent_mcp_enabled
from sec_review_agents.mcp.codegraph import codegraph_mcp_connections_for_backend
from sec_review_agents.mcp.playwright import playwright_mcp_connections_for_backend

CODEGRAPH_MCP_TOOL = "codegraph"
PLAYWRIGHT_MCP_TOOL = "playwright"

# Look builders up at call time so tests can patch the module attributes.
_AGENT_MCP_CONNECTIONS: dict[str, Callable[[Any], dict[str, Any]]] = {
    CODEGRAPH_MCP_TOOL: lambda backend: codegraph_mcp_connections_for_backend(backend),
    PLAYWRIGHT_MCP_TOOL: lambda backend: playwright_mcp_connections_for_backend(
        backend
    ),
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
    connections: dict[str, Any] = {}
    for builder in builders:
        connections.update(await _prepare_connection(builder, backend))
    return connections
