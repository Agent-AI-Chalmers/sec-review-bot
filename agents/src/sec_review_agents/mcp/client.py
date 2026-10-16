from collections.abc import Mapping
from contextlib import AsyncExitStack, asynccontextmanager
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


@asynccontextmanager
async def managed_mcp_tools_async(
    connections: Mapping[str, Any] | None,
    *,
    tool_name_prefix: bool = True,
):
    if not connections:
        yield []
        return

    from langchain_mcp_adapters.client import MultiServerMCPClient
    from langchain_mcp_adapters.tools import load_mcp_tools

    client = MultiServerMCPClient(
        dict(connections),
        tool_name_prefix=tool_name_prefix,
    )
    async with AsyncExitStack() as stack:
        tools: list[Any] = []
        for server_name in connections:
            session = await stack.enter_async_context(client.session(server_name))
            tools.extend(
                await load_mcp_tools(
                    session,
                    server_name=server_name,
                    tool_name_prefix=tool_name_prefix,
                )
            )
        yield tools
