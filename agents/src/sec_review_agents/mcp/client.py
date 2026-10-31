from collections.abc import Mapping
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Any


@asynccontextmanager
async def managed_mcp_tools_async(
    connections: Mapping[str, Any] | None,
    *,
    tool_name_prefix: bool = True,
):
    """Yield tools bound to sessions shared across tool calls.

    Use the tools only inside this context. Exiting closes the sessions,
    including when tool loading or agent execution fails or is cancelled.
    """
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
