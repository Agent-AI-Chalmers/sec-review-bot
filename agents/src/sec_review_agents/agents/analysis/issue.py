from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.analysis.skills import ANALYSIS_AGENT_SKILLS
from sec_review_agents.features import agent_memory_enabled, agent_skills_enabled
from sec_review_agents.filesystem import backend_selection
from sec_review_agents.filesystem.backend_factory import create_backend_with_materials
from sec_review_agents.filesystem.material_views import (
    read_only_material_view,
    skill_view,
    tmp_view_for_backend,
    workspace_view,
)
from sec_review_agents.memory.store import configured_memory_material_view
from sec_review_agents.resources.loader import join_prompt_sections
from sec_review_agents.runtime.runtime_config import (
    RunnerRuntimeContext,
    runtime_workspace_image,
)
from sec_review_agents.runtime.skills import materialize_agent_skills_view
from sec_review_agents.utils.structured_renderer import (
    render_structured_markdown_section,
)
from sec_review_agents.workflows.review_intent import ReviewObjective

ISSUE_ANALYZER_INTRO = "\n".join(
    [
        "# Task",
        "",
        "Analyze the provided security signal against the prepared repository materials.",
    ]
)


def create_issue_analyzer_backend(
    *,
    workspace_root_path: Path,
    history_path: Path,
    runtime_context: RunnerRuntimeContext | None = None,
):
    workspace_image = runtime_workspace_image(runtime_context)
    backend_kind = backend_selection.selected_sandbox_backend_kind()
    memory_view = configured_memory_material_view() if agent_memory_enabled() else None
    tmp_view = tmp_view_for_backend(backend_kind)
    material_views = [
        workspace_view(host_path=workspace_root_path, writable=True),
        read_only_material_view(agent_path="/history", host_path=history_path),
    ]
    if agent_skills_enabled():
        material_views.append(
            skill_view(host_path=materialize_agent_skills_view(ANALYSIS_AGENT_SKILLS))
        )
    if memory_view is not None:
        material_views.append(memory_view)
    if tmp_view is not None:
        material_views.append(tmp_view)

    return create_backend_with_materials(
        container_name_prefix="issue-analyzer",
        material_views=material_views,
        image=workspace_image,
        backend_kind=backend_kind,
    )


def build_issue_analyzer_system_prompt(review_objective: ReviewObjective) -> str:
    return join_prompt_sections(
        [
            "analyzer/system-core.md",
            f"review-objectives/{review_objective}/analyzer-delta.md",
            "shared/runtime-evidence-discipline.md",
            "shared/validation-level-discipline.md",
            "shared/input-location-hints-rule.md",
            "shared/security-false-positive-precedents.md",
            "scopes/issue/analyzer/system-delta.md",
            "shared/workspace-evidence-rule.md",
            "shared/advisory-evidence-rule.md",
        ]
    )


def build_issue_analyzer_filesystem_system_prompt() -> str:
    return join_prompt_sections(
        [
            "analyzer/filesystem-system-core.md",
            "scopes/issue/analyzer/filesystem-system-delta.md",
        ]
    )


def build_issue_analyzer_user_prompt(*, issue: Mapping[str, Any]) -> str:
    title = issue.get("title")
    body = issue.get("body")
    return "\n".join(
        [
            ISSUE_ANALYZER_INTRO,
            "",
            render_structured_markdown_section(
                "Issue Text",
                {
                    "title": (
                        title.strip()
                        if isinstance(title, str) and title.strip()
                        else "(missing)"
                    ),
                    "body": (
                        body.strip()
                        if isinstance(body, str) and body.strip()
                        else "(empty)"
                    ),
                },
                profile="prompt",
            ),
        ]
    )
