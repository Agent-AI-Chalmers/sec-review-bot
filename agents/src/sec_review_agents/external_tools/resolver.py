"""Resolve external CLI guidance from deployment and agent declarations."""

from collections.abc import Iterable

from sec_review_agents.external_tools.catalog import EXTERNAL_TOOL_PROMPT_PATHS
from sec_review_agents.filesystem.backend_selection import (
    selected_sandbox_backend_kind,
)
from sec_review_agents.utils.env import bool_env


def configured_external_tools() -> tuple[str, ...]:
    return tuple(
        name
        for name, (enabled_env, _) in EXTERNAL_TOOL_PROMPT_PATHS.items()
        if bool_env(enabled_env, False)
    )


def external_tool_prompt_paths_for(
    agent_tool_names: Iterable[str],
) -> tuple[str, ...]:
    declared = {name.strip().lower() for name in agent_tool_names}
    unknown = sorted(declared.difference(EXTERNAL_TOOL_PROMPT_PATHS))
    if unknown:
        raise ValueError("Unknown agent external tool(s): " + ", ".join(unknown))
    selected = set(configured_external_tools()).intersection(declared)
    if selected:
        selected_sandbox_backend_kind()
    return tuple(
        path
        for name, (_, path) in EXTERNAL_TOOL_PROMPT_PATHS.items()
        if name in selected
    )


__all__ = ["configured_external_tools", "external_tool_prompt_paths_for"]
