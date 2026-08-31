from collections.abc import Callable
from typing import Any

from sec_review_agents.features import agent_mcp_enabled
from sec_review_agents.mcp.codegraph import codegraph_mcp_connections_for_backend

CODEGRAPH_MCP_TOOL = "codegraph"

_AGENT_MCP_RESOLVERS: dict[str, Callable[[Any], Callable[[], Any]]] = {
    CODEGRAPH_MCP_TOOL: lambda backend: (
        lambda: codegraph_mcp_connections_for_backend(backend)
    ),
}


def resolve_agent_mcp_connection_factories(
    tool_names: tuple[str, ...],
    backend: Any,
) -> list[Callable[[], Any]]:
    factories: list[Callable[[], Any]] = []
    for tool_name in tool_names:
        # This is an allowlist resolver, not MCP discovery. Agent declarations
        # name project-owned integrations; each name must map to explicit code.
        resolver = _AGENT_MCP_RESOLVERS.get(tool_name)
        if resolver is None:
            raise ValueError(f"Unknown agent MCP tool: {tool_name}")
        factories.append(resolver(backend))
    if not agent_mcp_enabled():
        return []
    return factories
