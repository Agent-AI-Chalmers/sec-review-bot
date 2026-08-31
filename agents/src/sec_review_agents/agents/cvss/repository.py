from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.filesystem.backend_factory import create_backend_with_materials
from sec_review_agents.filesystem.material_views import (
    host_tmp_view,
    workspace_view,
)
from sec_review_agents.resources.loader import join_prompt_sections
from sec_review_agents.utils.markdown import json_section

REPOSITORY_CVSS_V4_SCORER_NAME = "repository-cvss-v4-scorer"
REPOSITORY_CVSS_V4_INTRO = "\n".join(
    [
        "# Task",
        "",
        (
            "Score one analyzed repository-security case with CVSS v4.0 Base metrics, "
            "or return not-scored when the current case is not independently CVSS-scoreable."
        ),
    ]
)

# This is intentionally user-prompt context rather than system-prompt policy.
# The CVSS scorer should be reusable across workflows; only this repository
# workflow knows that the analyzer's top-priority confirmed narrative is the case target.
REPOSITORY_CVSS_V4_SCORING_TARGET = "\n".join(
    [
        "# Scoring Target",
        "",
        "Anchor scoring to `Analysis Result For Scoring.top_priority_narrative`.",
        "",
        "Selection rule:",
        "- Use the scoreable confirmed analyzer narrative with the lowest positive `priority`.",
        "- Use original order as a tie-breaker.",
    ]
)


def create_repository_cvss_backend(
    *,
    workspace_root_path: Path,
):
    """Create the local writable backend used by repository CVSS scoring."""
    # CVSS runs locally against a stage-owned workspace copy. The workspace is
    # writable so tools can create indexes or caches without touching baseline.
    return create_backend_with_materials(
        container_name_prefix="repository-cvss",
        material_views=[
            workspace_view(host_path=workspace_root_path, writable=True),
            host_tmp_view(),
        ],
        use_docker_sandbox=False,
    )


def build_repository_cvss_v4_system_prompt() -> str:
    return join_prompt_sections(
        [
            "cvss-scorer/system.md",
            "shared/workspace-evidence-rule.md",
        ]
    )


def build_repository_cvss_v4_filesystem_system_prompt() -> str:
    return join_prompt_sections(
        [
            "cvss-scorer/filesystem-system.md",
            "shared/read-only-filesystem-exploration-rule.md",
        ]
    )


def build_repository_cvss_v4_user_prompt(
    *,
    review_input: str,
    analysis_result: Mapping[str, Any],
) -> str:
    top_priority_narrative = _top_priority_narrative(analysis_result)
    return "\n".join(
        [
            REPOSITORY_CVSS_V4_INTRO,
            "",
            review_input,
            "",
            json_section(
                "Analysis Result For Scoring",
                {
                    "overview": analysis_result.get("overview"),
                    "verdict": analysis_result.get("verdict"),
                    "narratives": analysis_result.get("narratives") or [],
                    "top_priority_narrative": top_priority_narrative,
                },
            ),
            "",
            REPOSITORY_CVSS_V4_SCORING_TARGET,
        ]
    )


def _top_priority_narrative(analysis_result: Mapping[str, Any]) -> dict[str, Any]:
    narratives = analysis_result.get("narratives") or []
    if not isinstance(narratives, list):
        return {}

    ranked: list[tuple[int, int, dict]] = []
    for index, narrative in enumerate(narratives):
        if not isinstance(narrative, dict):
            continue
        if narrative.get("verdict") != "confirmed-vulnerability":
            continue
        priority = narrative.get("priority")
        if not isinstance(priority, int) or priority < 1:
            priority = 10_000
        ranked.append((priority, index, narrative))

    if ranked:
        ranked.sort(key=lambda item: (item[0], item[1]))
        return ranked[0][2]

    return {}
