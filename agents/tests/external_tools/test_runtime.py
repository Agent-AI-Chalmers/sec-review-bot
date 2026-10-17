from unittest.mock import patch

import pytest

from sec_review_agents.runtime.external_tools import (
    configured_external_tools,
    external_tool_prompt_paths_for,
)


@pytest.mark.parametrize(
    ("joern_enabled", "playwright_enabled", "expected_tools", "expected_paths"),
    [
        (False, False, (), ()),
        (True, False, ("joern",), ("external-tools/joern.md",)),
        (
            False,
            True,
            ("playwright",),
            ("external-tools/playwright.md",),
        ),
        (
            True,
            True,
            ("joern", "playwright"),
            ("external-tools/joern.md", "external-tools/playwright.md"),
        ),
    ],
)
def test_external_tool_selection(
    monkeypatch,
    joern_enabled: bool,
    playwright_enabled: bool,
    expected_tools: tuple[str, ...],
    expected_paths: tuple[str, ...],
) -> None:
    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", "docker")
    monkeypatch.setenv("AGENT_JOERN_ENABLED", str(joern_enabled))
    monkeypatch.setenv("AGENT_PLAYWRIGHT_ENABLED", str(playwright_enabled))

    assert configured_external_tools() == expected_tools
    assert external_tool_prompt_paths_for(("joern", "playwright")) == expected_paths


def test_external_tool_prompts_intersect_configuration_and_agent_declaration(
    monkeypatch,
) -> None:
    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", "docker")
    monkeypatch.setenv("AGENT_JOERN_ENABLED", "true")
    monkeypatch.setenv("AGENT_PLAYWRIGHT_ENABLED", "true")

    assert external_tool_prompt_paths_for(("joern",)) == ("external-tools/joern.md",)
    assert external_tool_prompt_paths_for(()) == ()


def test_external_tool_selection_rejects_unknown_agent_declaration(
    monkeypatch,
) -> None:
    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", "docker")
    monkeypatch.setenv("AGENT_JOERN_ENABLED", "true")

    with pytest.raises(ValueError, match="Unknown agent external tool.*unknown"):
        external_tool_prompt_paths_for(("unknown",))


def test_external_tool_prompts_reject_local_backend(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", "local")
    monkeypatch.setenv("AGENT_JOERN_ENABLED", "true")

    with pytest.raises(
        ValueError,
        match="External CLI tools require an execution-capable sandbox backend",
    ):
        external_tool_prompt_paths_for(("joern",))


def test_external_tool_prompts_reject_auto_local_fallback(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", "auto")
    monkeypatch.setenv("AGENT_PLAYWRIGHT_ENABLED", "true")

    with (
        patch(
            "sec_review_agents.filesystem.backend_selection."
            "is_docker_runtime_available",
            return_value=False,
        ),
        pytest.raises(
            ValueError,
            match="External CLI tools require an execution-capable sandbox backend",
        ),
    ):
        external_tool_prompt_paths_for(("playwright",))
