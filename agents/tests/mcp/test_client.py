from unittest.mock import patch

import pytest

from sec_review_agents.mcp.client import load_mcp_tools_async


class FakeMultiServerMCPClient:
    def __init__(self, connections, *, tool_name_prefix):
        self.connections = connections
        self.tool_name_prefix = tool_name_prefix

    async def get_tools(self):
        return ["tool-a", "tool-b"]


@pytest.mark.asyncio
async def test_load_mcp_tools_async_empty_connections_returns_without_adapter() -> None:
    assert await load_mcp_tools_async({}) == []


@pytest.mark.asyncio
async def test_load_mcp_tools_async_awaits_adapter_client() -> None:
    with patch(
        "langchain_mcp_adapters.client.MultiServerMCPClient",
        FakeMultiServerMCPClient,
    ):
        tools = await load_mcp_tools_async(
            {"codegraph": {"transport": "stdio"}},
            tool_name_prefix=False,
        )

    assert tools == ["tool-a", "tool-b"]
