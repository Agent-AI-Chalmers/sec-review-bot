import pytest

from sec_review_agents.mcp.resolver import resolve_agent_mcp_connections


def test_mcp_connections_resolve_declared_codegraph_tool(monkeypatch) -> None:
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

    connections = resolve_agent_mcp_connections(("codegraph",), backend)

    assert connections == {"codegraph": {"transport": "stdio"}}
    assert calls == [backend]


def test_mcp_connections_resolve_declared_playwright_tool(
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

    connections = resolve_agent_mcp_connections(("playwright",), backend)

    assert connections == {"playwright": {"transport": "stdio"}}
    assert calls == [backend]


def test_mcp_connections_reject_unknown_tool() -> None:
    with pytest.raises(ValueError, match="Unknown agent MCP tool: osv"):
        resolve_agent_mcp_connections(("osv",), object())


def test_mcp_connections_global_disable_skips_resolution(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_MCP_ENABLED", "false")

    connections = resolve_agent_mcp_connections(("codegraph",), object())

    assert connections == {}


def test_mcp_connections_global_disable_still_rejects_unknown_tool(
    monkeypatch,
) -> None:
    monkeypatch.setenv("AGENT_MCP_ENABLED", "false")

    with pytest.raises(ValueError, match="Unknown agent MCP tool: osv"):
        resolve_agent_mcp_connections(("osv", "codegraph"), object())
