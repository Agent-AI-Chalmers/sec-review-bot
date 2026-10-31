from contextlib import asynccontextmanager
from typing import ClassVar
from unittest.mock import patch

import pytest

from sec_review_agents.mcp.client import (
    managed_mcp_tools_async,
)


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
async def test_empty_connections_do_not_create_a_client() -> None:
    with patch("langchain_mcp_adapters.client.MultiServerMCPClient") as client:
        async with managed_mcp_tools_async({}) as tools:
            assert tools == []
    client.assert_not_called()


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


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["connect", "load"])
async def test_partial_initialization_closes_sessions(
    failure: str, monkeypatch
) -> None:
    """A later server failure must release sessions opened for earlier servers."""
    FakeManagedMultiServerMCPClient.events = []

    class Client(FakeManagedMultiServerMCPClient):
        @asynccontextmanager
        async def session(self, server_name):
            if failure == "connect" and server_name == "playwright":
                raise RuntimeError("connect failed")
            async with super().session(server_name) as session:
                yield session

    async def load_tools(session, *, server_name, tool_name_prefix):
        if failure == "load" and server_name == "playwright":
            raise RuntimeError("load failed")
        return [session]

    monkeypatch.setattr("langchain_mcp_adapters.client.MultiServerMCPClient", Client)
    monkeypatch.setattr("langchain_mcp_adapters.tools.load_mcp_tools", load_tools)
    with pytest.raises(RuntimeError, match=f"{failure} failed"):
        async with managed_mcp_tools_async(
            {
                "codegraph": {"transport": "stdio"},
                "playwright": {"transport": "stdio"},
            }
        ):
            pytest.fail("An incompletely initialized tool set must not escape.")

    assert FakeManagedMultiServerMCPClient.events == (
        ["open:codegraph", "close:codegraph"]
        if failure == "connect"
        else [
            "open:codegraph",
            "open:playwright",
            "close:playwright",
            "close:codegraph",
        ]
    )
