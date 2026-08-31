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

PR_ANALYZER_INTRO = "\n".join(
    [
        "# Task",
        "",
        "Analyze the provided security signal against the prepared repository materials.",
    ]
)


def create_pr_analyzer_backend(
    *,
    workspace_root_path: Path,
    history_path: Path,
    incremental_window_path: Path,
    runtime_context: RunnerRuntimeContext | None = None,
):
    workspace_image = runtime_workspace_image(runtime_context)
    backend_kind = backend_selection.selected_sandbox_backend_kind()
    memory_view = configured_memory_material_view() if agent_memory_enabled() else None
    tmp_view = tmp_view_for_backend(backend_kind)
    material_views = [
        workspace_view(host_path=workspace_root_path, writable=True),
        read_only_material_view(
            agent_path="/incremental-window",
            host_path=incremental_window_path,
        ),
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
        container_name_prefix="pr-analyzer",
        material_views=material_views,
        image=workspace_image,
        backend_kind=backend_kind,
    )


def build_pr_analyzer_system_prompt() -> str:
    return join_prompt_sections(
        [
            "analyzer/system-core.md",
            "review-objectives/audit/analyzer-delta.md",
            "shared/runtime-evidence-discipline.md",
            "shared/validation-level-discipline.md",
            "shared/input-location-hints-rule.md",
            "shared/security-false-positive-precedents.md",
            "scopes/pr/analyzer/system-delta.md",
            "shared/workspace-evidence-rule.md",
            "shared/advisory-evidence-rule.md",
        ]
    )


def build_pr_analyzer_filesystem_system_prompt() -> str:
    return join_prompt_sections(
        [
            "analyzer/filesystem-system-core.md",
            "scopes/pr/analyzer/filesystem-system-delta.md",
        ]
    )


def build_pr_analyzer_user_prompt(
    *,
    pr: Mapping[str, Any],
    diff_metadata: Mapping[str, Any],
) -> str:
    title = pr.get("title")
    body = pr.get("body")
    base_ref = pr.get("base_ref")
    base_sha = pr.get("base_sha")
    head_ref = pr.get("head_ref")
    head_sha = pr.get("head_sha")
    return "\n".join(
        [
            PR_ANALYZER_INTRO,
            "",
            render_structured_markdown_section(
                "Pull Request Text",
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
            "",
            render_structured_markdown_section(
                "Pull Request Reference",
                {
                    "base_ref": (
                        base_ref.strip()
                        if isinstance(base_ref, str) and base_ref.strip()
                        else "(missing)"
                    ),
                    "base_sha": (
                        base_sha.strip()
                        if isinstance(base_sha, str) and base_sha.strip()
                        else "(missing)"
                    ),
                    "head_ref": (
                        head_ref.strip()
                        if isinstance(head_ref, str) and head_ref.strip()
                        else "(missing)"
                    ),
                    "head_sha": (
                        head_sha.strip()
                        if isinstance(head_sha, str) and head_sha.strip()
                        else "(missing)"
                    ),
                    "commit_shas": pr.get("commit_shas") or [],
                },
                profile="prompt",
            ),
            "",
            render_structured_markdown_section(
                "Pull Request Diff Metadata",
                diff_metadata,
                profile="prompt",
            ),
        ]
    )
