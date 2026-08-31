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
from sec_review_agents.resources.loader import (
    join_prompt_sections,
    load_prompt_resource,
)
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

REPOSITORY_MITIGATION_INITIAL_INTRO = "\n".join(
    [
        "# Task",
        "",
        "Apply a minimal mitigation in the prepared workspace for the provided security analysis.",
    ]
)
REPOSITORY_MITIGATION_RETRY_INTRO = "\n".join(
    [
        "# Task",
        "",
        "Revise the existing mitigation in the prepared workspace using verifier feedback from the previous pass.",
    ]
)


def create_repository_mitigation_backend(
    *,
    workspace_root: Path,
    history_path: Path | None,
    incremental_window_path: Path | None,
    scan_mode: str,
    runtime_context: RunnerRuntimeContext | None = None,
):
    workspace_image = runtime_workspace_image(runtime_context)
    backend_kind = backend_selection.selected_sandbox_backend_kind()
    memory_view = configured_memory_material_view() if agent_memory_enabled() else None
    tmp_view = tmp_view_for_backend(backend_kind)
    material_views = [
        workspace_view(host_path=workspace_root, writable=True),
    ]
    if agent_skills_enabled():
        material_views.append(
            skill_view(host_path=materialize_agent_skills_view(MITIGATION_AGENT_SKILLS))
        )
    if memory_view is not None:
        material_views.append(memory_view)
    if tmp_view is not None:
        material_views.append(tmp_view)
    if scan_mode == "incremental":
        if incremental_window_path is None:
            raise KeyError("Missing bundle path: incremental_window_path")
        if history_path is None:
            raise KeyError("Missing bundle path: history_path")
        material_views.extend(
            [
                read_only_material_view(
                    agent_path="/incremental-window",
                    host_path=incremental_window_path,
                ),
                read_only_material_view(
                    agent_path="/history",
                    host_path=history_path,
                ),
            ]
        )

    return create_backend_with_materials(
        container_name_prefix="repository-mitigator",
        material_views=material_views,
        image=workspace_image,
        backend_kind=backend_kind,
    )


def build_repository_mitigation_system_prompt(
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
            "scopes/repository/mitigator/system-delta.md",
            "shared/workspace-evidence-rule.md",
        ]
    )
    return join_prompt_sections(paths)


def build_repository_mitigation_filesystem_system_prompt(
    scan_mode: str,
) -> str:
    paths = [
        "mitigator/filesystem-system-core.md",
        "scopes/repository/mitigator/filesystem-system-delta.md",
    ]
    if scan_mode == "incremental":
        paths.append("shared/incremental-evidence-rule.md")
    return join_prompt_sections(paths)


def build_repository_mitigation_user_prompt(
    *,
    review_input: str,
    scan_mode: str,
    retry_context: Mapping[str, Any] | None,
    analysis_result: Mapping[str, Any],
) -> str:
    incremental_scope_rule = (
        load_prompt_resource("shared/incremental-window-scope-rule.md")
        if scan_mode == "incremental"
        else None
    )
    feedback_retry = mitigation_feedback_retry_context(retry_context)

    sections = [
        (
            REPOSITORY_MITIGATION_RETRY_INTRO
            if isinstance(feedback_retry, dict)
            else REPOSITORY_MITIGATION_INITIAL_INTRO
        )
    ]
    if incremental_scope_rule:
        sections.extend(["", incremental_scope_rule])
    sections.extend(["", review_input])
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
