from collections.abc import Iterable

from sec_review_agents.filesystem.backend_selection import (
    selected_sandbox_backend_kind,
)
from sec_review_agents.utils.env import env_value, parse_bool_env

AGENT_JOERN_ENABLED_ENV = "AGENT_JOERN_ENABLED"
AGENT_PLAYWRIGHT_ENABLED_ENV = "AGENT_PLAYWRIGHT_ENABLED"

_EXTERNAL_TOOL_PROMPT_PATHS = {
    "joern": (AGENT_JOERN_ENABLED_ENV, "external-tools/joern.md"),
    "playwright": (AGENT_PLAYWRIGHT_ENABLED_ENV, "external-tools/playwright.md"),
}


def configured_external_tools() -> tuple[str, ...]:
    return tuple(
        name
        for name, (enabled_env, _) in _EXTERNAL_TOOL_PROMPT_PATHS.items()
        if parse_bool_env(env_value(enabled_env), False)
    )


def external_tool_prompt_paths_for(
    agent_tool_names: Iterable[str],
) -> tuple[str, ...]:
    declared = {name.strip().lower() for name in agent_tool_names}
    unknown = sorted(declared.difference(_EXTERNAL_TOOL_PROMPT_PATHS))
    if unknown:
        raise ValueError("Unknown agent external tool(s): " + ", ".join(unknown))
    selected = set(configured_external_tools()).intersection(declared)
    backend_kind = selected_sandbox_backend_kind() if selected else None
    if selected and backend_kind == "local":
        raise ValueError(
            "External CLI tools require an execution-capable sandbox backend; "
            "AGENT_SANDBOX_BACKEND resolved to local"
        )
    if "playwright" in selected and backend_kind == "bwrap":
        raise ValueError(
            "Playwright CLI requires the persistent Docker sandbox; "
            "the bwrap backend creates a new namespace for each command"
        )
    return tuple(
        path
        for name, (_, path) in _EXTERNAL_TOOL_PROMPT_PATHS.items()
        if name in selected
    )


__all__ = [
    "AGENT_JOERN_ENABLED_ENV",
    "AGENT_PLAYWRIGHT_ENABLED_ENV",
    "configured_external_tools",
    "external_tool_prompt_paths_for",
]
