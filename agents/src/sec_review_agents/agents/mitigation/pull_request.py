from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.mitigation.skills import MITIGATION_AGENT_SKILLS
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
from sec_review_agents.review_stages.feedback_loop import (
    mitigation_feedback_retry_context,
    render_retry_revision_context_section,
)
from sec_review_agents.runtime.runtime_config import (
    RunnerRuntimeContext,
    runtime_workspace_image,
)
from sec_review_agents.runtime.skills import materialize_agent_skills_view
from sec_review_agents.utils.structured_renderer import (
    render_structured_markdown_section,
)
from sec_review_agents.workflows.review_intent import (
    REPAIR_MODE_TEST_CHANGES_ALLOWED,
    RepairMode,
    repair_mode_boundary_prompt_path,
)

PR_MITIGATION_INITIAL_INTRO = "\n".join(
    [
        "# Task",
        "",
        "Apply a minimal mitigation in the prepared workspace for the provided security analysis.",
    ]
)
PR_MITIGATION_RETRY_INTRO = "\n".join(
    [
        "# Task",
        "",
        "Revise the existing mitigation in the prepared workspace using verifier feedback from the previous pass.",
    ]
)


def create_pr_mitigation_backend(
    *,
    workspace_root: Path,
    history_path: Path,
    incremental_window_path: Path,
    runtime_context: RunnerRuntimeContext | None = None,
):
    workspace_image = runtime_workspace_image(runtime_context)
    backend_kind = backend_selection.selected_sandbox_backend_kind()
    memory_view = configured_memory_material_view() if agent_memory_enabled() else None
    tmp_view = tmp_view_for_backend(backend_kind)
    material_views = [
        workspace_view(host_path=workspace_root, writable=True),
        read_only_material_view(
            agent_path="/incremental-window",
            host_path=incremental_window_path,
        ),
        read_only_material_view(agent_path="/history", host_path=history_path),
    ]
    if agent_skills_enabled():
        material_views.append(
            skill_view(host_path=materialize_agent_skills_view(MITIGATION_AGENT_SKILLS))
        )
    if memory_view is not None:
        material_views.append(memory_view)
    if tmp_view is not None:
        material_views.append(tmp_view)

    return create_backend_with_materials(
        container_name_prefix="pr-mitigator",
        material_views=material_views,
        image=workspace_image,
        backend_kind=backend_kind,
    )


def build_pr_mitigation_system_prompt(
    *,
    repair_mode: RepairMode = REPAIR_MODE_TEST_CHANGES_ALLOWED,
    is_retry: bool = False,
) -> str:
    paths = [
        "mitigator/system-core.md",
        repair_mode_boundary_prompt_path(repair_mode),
        "shared/no-git-history-remediation-boundary.md",
        "shared/runtime-evidence-discipline.md",
        "shared/input-location-hints-rule.md",
    ]
    if is_retry:
        paths.append("mitigator/system-retry-delta.md")
    paths.extend(
        [
            "scopes/pr/mitigator/system-delta.md",
            "shared/workspace-evidence-rule.md",
        ]
    )
    return join_prompt_sections(paths)


def build_pr_mitigation_filesystem_system_prompt() -> str:
    return join_prompt_sections(
        [
            "mitigator/filesystem-system-core.md",
            "scopes/pr/mitigator/filesystem-system-delta.md",
        ]
    )


def build_pr_mitigation_user_prompt(
    *,
    pr: Mapping[str, Any],
    retry_context: Mapping[str, Any] | None,
    analysis_result: Mapping[str, Any],
    diff_metadata: Mapping[str, Any],
) -> str:
    feedback_retry = mitigation_feedback_retry_context(retry_context)
    title = pr.get("title")
    body = pr.get("body")
    base_ref = pr.get("base_ref")
    base_sha = pr.get("base_sha")
    head_ref = pr.get("head_ref")
    head_sha = pr.get("head_sha")

    sections = [
        (
            PR_MITIGATION_RETRY_INTRO
            if isinstance(feedback_retry, dict)
            else PR_MITIGATION_INITIAL_INTRO
        ),
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
    retry_revision_context = render_retry_revision_context_section(feedback_retry)
    if retry_revision_context:
        sections.extend(["", retry_revision_context])
    sections.extend(
        [
            "",
            render_structured_markdown_section(
                "Analyzer Context",
                analysis_result,
                profile="prompt",
            ),
        ]
    )
    return "\n".join(sections)
