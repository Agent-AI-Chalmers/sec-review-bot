"""External CLI integration selection for review agents."""

from sec_review_agents.external_tools.resolver import (
    configured_external_tools,
    external_tool_prompt_paths_for,
)

__all__ = [
    "configured_external_tools",
    "external_tool_prompt_paths_for",
]
