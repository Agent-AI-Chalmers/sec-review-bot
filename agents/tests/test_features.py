from sec_review_agents.features import (
    agent_mcp_enabled,
    agent_memory_enabled,
    agent_skills_enabled,
)


def test_agent_skills_enabled_defaults_to_true(monkeypatch) -> None:
    monkeypatch.delenv("AGENT_SKILLS_ENABLED", raising=False)

    assert agent_skills_enabled() is True


def test_agent_skills_disabled(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_SKILLS_ENABLED", "false")

    assert agent_skills_enabled() is False


def test_agent_mcp_enabled_defaults_to_true(monkeypatch) -> None:
    monkeypatch.delenv("AGENT_MCP_ENABLED", raising=False)

    assert agent_mcp_enabled() is True


def test_agent_mcp_disabled(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_MCP_ENABLED", "false")

    assert agent_mcp_enabled() is False


def test_agent_memory_enabled_defaults_to_true(monkeypatch) -> None:
    monkeypatch.delenv("AGENT_MEMORY_ENABLED", raising=False)

    assert agent_memory_enabled() is True


def test_agent_memory_disabled(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_MEMORY_ENABLED", "false")

    assert agent_memory_enabled() is False
