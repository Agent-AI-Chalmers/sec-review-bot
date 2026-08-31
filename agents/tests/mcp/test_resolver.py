import pytest

from sec_review_agents.mcp.resolver import resolve_agent_mcp_connection_factories


def test_mcp_connection_factories_resolve_declared_codegraph_tool(monkeypatch) -> None:
    backend = object()
    calls = []

    def fake_codegraph_connections(received_backend):
        calls.append(received_backend)
        return {"codegraph": {"transport": "stdio"}}

    monkeypatch.setattr(
        "sec_review_agents.mcp.resolver.codegraph_mcp_connections_for_backend",
        fake_codegraph_connections,
    )

    factories = resolve_agent_mcp_connection_factories(("codegraph",), backend)

    assert len(factories) == 1
    assert factories[0]() == {"codegraph": {"transport": "stdio"}}
    assert calls == [backend]


def test_mcp_connection_factories_reject_unknown_tool() -> None:
    with pytest.raises(ValueError, match="Unknown agent MCP tool: osv"):
        resolve_agent_mcp_connection_factories(("osv",), object())


def test_mcp_connection_factories_global_disable_skips_resolution(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_MCP_ENABLED", "false")

    factories = resolve_agent_mcp_connection_factories(("codegraph",), object())

    assert factories == []


def test_mcp_connection_factories_global_disable_still_rejects_unknown_tool(
    monkeypatch,
) -> None:
    monkeypatch.setenv("AGENT_MCP_ENABLED", "false")

    with pytest.raises(ValueError, match="Unknown agent MCP tool: osv"):
        resolve_agent_mcp_connection_factories(("osv", "codegraph"), object())
