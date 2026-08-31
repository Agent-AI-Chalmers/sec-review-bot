from pathlib import Path

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
from sec_review_agents.resources.loader import (
    join_prompt_sections,
    load_prompt_resource,
)
from sec_review_agents.runtime.runtime_config import (
    RunnerRuntimeContext,
    runtime_workspace_image,
)
from sec_review_agents.runtime.skills import materialize_agent_skills_view

REPOSITORY_ANALYZER_INTRO = "\n".join(
    [
        "# Task",
        "",
        "Analyze the provided security signal against the prepared repository materials.",
    ]
)


def create_repository_analyzer_backend(
    *,
    workspace_root_path: Path,
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
        workspace_view(host_path=workspace_root_path, writable=True),
    ]
    if agent_skills_enabled():
        material_views.append(
            skill_view(host_path=materialize_agent_skills_view(ANALYSIS_AGENT_SKILLS))
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
        container_name_prefix="repository-analyzer",
        material_views=material_views,
        image=workspace_image,
        backend_kind=backend_kind,
    )


def build_repository_analyzer_system_prompt() -> str:
    return join_prompt_sections(
        [
            "analyzer/system-core.md",
            "review-objectives/audit/analyzer-delta.md",
            "shared/runtime-evidence-discipline.md",
            "shared/validation-level-discipline.md",
            "shared/input-location-hints-rule.md",
            "shared/security-false-positive-precedents.md",
            "scopes/repository/analyzer/system-delta.md",
            "shared/workspace-evidence-rule.md",
            "shared/advisory-evidence-rule.md",
        ]
    )


def build_repository_analyzer_filesystem_system_prompt(
    scan_mode: str,
) -> str:
    paths = [
        "analyzer/filesystem-system-core.md",
        "scopes/repository/analyzer/filesystem-system-delta.md",
    ]
    if scan_mode == "incremental":
        paths.append("shared/incremental-evidence-rule.md")
    return join_prompt_sections(paths)


def build_repository_analyzer_user_prompt(*, review_input: str, scan_mode: str) -> str:
    incremental_scope_rule = (
        load_prompt_resource("shared/incremental-window-scope-rule.md")
        if scan_mode == "incremental"
        else None
    )
    sections = [REPOSITORY_ANALYZER_INTRO]
    if incremental_scope_rule:
        sections.extend(["", incremental_scope_rule])
    sections.extend(["", review_input])
    return "\n".join(sections)
