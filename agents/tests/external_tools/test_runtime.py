from unittest.mock import patch

import pytest

from sec_review_agents.external_tools import (
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


def test_external_tool_prompts_reject_a_shell_less_backend(monkeypatch) -> None:
    """An external CLI needs a sandbox that can run it.

    No operator setting resolves to `local` any more, so the check is exercised by
    forcing the resolution directly: it guards the boundary rather than a
    reachable configuration.
    """
    monkeypatch.setenv("AGENT_JOERN_ENABLED", "true")

    with (
        patch(
            "sec_review_agents.external_tools.resolver.selected_sandbox_backend_kind",
            return_value="local",
        ),
        pytest.raises(
            ValueError,
            match="External CLI tools require an execution-capable sandbox backend",
        ),
    ):
        external_tool_prompt_paths_for(("joern",))


def test_external_tool_prompts_fail_when_no_sandbox_resolves(monkeypatch) -> None:
    """`auto` with no usable sandbox must not silently pick a text reader."""
    # Declare the policy under test. A concrete value here (from `agents/.env`, which another
    # test may have loaded) skips the probe entirely and the check never runs.
    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", "auto")
    monkeypatch.setenv("AGENT_PLAYWRIGHT_ENABLED", "true")

    with (
        patch(
            "sec_review_agents.filesystem.backend_selection."
            "is_docker_runtime_available",
            return_value=False,
        ),
        pytest.raises(ValueError, match="found no usable sandbox"),
    ):
        external_tool_prompt_paths_for(("playwright",))


def test_bwrap_allows_joern_but_rejects_playwright(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", "bwrap")
    monkeypatch.setenv("AGENT_JOERN_ENABLED", "true")
    monkeypatch.setenv("AGENT_PLAYWRIGHT_ENABLED", "true")

    assert external_tool_prompt_paths_for(("joern",)) == ("external-tools/joern.md",)
    with pytest.raises(ValueError, match="Playwright CLI requires.*Docker sandbox"):
        external_tool_prompt_paths_for(("playwright",))
