from collections.abc import Mapping
from typing import Any


async def load_mcp_tools_async(
    connections: Mapping[str, Any] | None,
    *,
    tool_name_prefix: bool = True,
) -> list[Any]:
    if not connections:
        return []

    from langchain_mcp_adapters.client import MultiServerMCPClient

    client = MultiServerMCPClient(
        dict(connections),
        tool_name_prefix=tool_name_prefix,
    )
    # MultiServerMCPClient.get_tools() is async because MCP tools are reached
    # over external transports, not as in-process Python callables.
    return list(await client.get_tools())
