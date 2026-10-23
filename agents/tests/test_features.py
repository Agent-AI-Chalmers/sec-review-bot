from sec_review_agents.features import (
    agent_mcp_enabled,
    agent_skills_enabled,
    memory_consumption_enabled,
    memory_processing_enabled,
)


def test_agent_skills_enabled_defaults_to_true(monkeypatch) -> None:
    monkeypatch.delenv("AGENT_SKILLS_ENABLED", raising=False)

    assert agent_skills_enabled() is True


def test_agent_skills_disabled(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_SKILLS_ENABLED", "false")

    assert agent_skills_enabled() is False


def test_agent_mcp_enabled_defaults_to_false(monkeypatch) -> None:
    monkeypatch.delenv("AGENT_MCP_ENABLED", raising=False)

    assert agent_mcp_enabled() is False


def test_agent_mcp_enabled(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_MCP_ENABLED", "true")

    assert agent_mcp_enabled() is True


def test_memory_consumption_enabled_defaults_to_true(monkeypatch) -> None:
    monkeypatch.delenv("AGENT_MEMORY_CONSUMPTION_ENABLED", raising=False)

    assert memory_consumption_enabled() is True


def test_agent_memory_disabled(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_MEMORY_CONSUMPTION_ENABLED", "false")

    assert memory_consumption_enabled() is False


def test_memory_processing_enabled_defaults_to_true(monkeypatch) -> None:
    monkeypatch.delenv("AGENT_MEMORY_PROCESSING_ENABLED", raising=False)

    assert memory_processing_enabled() is True


def test_memory_processing_disabled(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_MEMORY_PROCESSING_ENABLED", "false")

    assert memory_processing_enabled() is False
