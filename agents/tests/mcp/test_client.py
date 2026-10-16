from contextlib import asynccontextmanager
from typing import ClassVar
from unittest.mock import patch

import pytest

from sec_review_agents.mcp.client import (
    load_mcp_tools_async,
    managed_mcp_tools_async,
)


class FakeMultiServerMCPClient:
    def __init__(self, connections, *, tool_name_prefix):
        self.connections = connections
        self.tool_name_prefix = tool_name_prefix

    async def get_tools(self):
        return ["tool-a", "tool-b"]


class FakeManagedMultiServerMCPClient:
    events: ClassVar[list[str]] = []

    def __init__(self, connections, *, tool_name_prefix):
        self.connections = connections
        self.tool_name_prefix = tool_name_prefix

    @asynccontextmanager
    async def session(self, server_name):
        self.events.append(f"open:{server_name}")
        try:
            yield f"session:{server_name}"
        finally:
            self.events.append(f"close:{server_name}")


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


@pytest.mark.asyncio
async def test_managed_mcp_tools_share_sessions_until_context_exit() -> None:
    FakeManagedMultiServerMCPClient.events = []

    async def fake_load_mcp_tools(
        session,
        *,
        server_name,
        tool_name_prefix,
    ):
        assert tool_name_prefix is True
        return [f"tool:{server_name}:{session}"]

    with (
        patch(
            "langchain_mcp_adapters.client.MultiServerMCPClient",
            FakeManagedMultiServerMCPClient,
        ),
        patch(
            "langchain_mcp_adapters.tools.load_mcp_tools",
            side_effect=fake_load_mcp_tools,
        ),
    ):
        async with managed_mcp_tools_async(
            {
                "codegraph": {"transport": "stdio"},
                "playwright": {"transport": "stdio"},
            }
        ) as tools:
            assert tools == [
                "tool:codegraph:session:codegraph",
                "tool:playwright:session:playwright",
            ]
            assert FakeManagedMultiServerMCPClient.events == [
                "open:codegraph",
                "open:playwright",
            ]

    assert FakeManagedMultiServerMCPClient.events == [
        "open:codegraph",
        "open:playwright",
        "close:playwright",
        "close:codegraph",
    ]
