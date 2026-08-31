from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.single_agent.skills import SINGLE_AGENT_SKILLS
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
from sec_review_agents.utils.structured_renderer import (
    render_structured_markdown_section,
)
from sec_review_agents.workflows.review_intent import (
    REPAIR_MODE_TEST_CHANGES_ALLOWED,
    RepairMode,
    ReviewObjective,
    repair_mode_boundary_prompt_path,
)

ISSUE_SINGLE_AGENT_INITIAL_INTRO = "\n".join(
    [
        "# Task",
        "",
        "Inspect the prepared repository workspace for the provided issue, decide whether there is an actionable repository-grounded problem, apply a minimal fix when justified, then self-check your own result before producing the final structured output.",
    ]
)


def create_issue_single_agent_backend(
    *,
    workspace_root: Path,
    history_path: Path,
    runtime_context: RunnerRuntimeContext | None = None,
):
    workspace_image = runtime_workspace_image(runtime_context)
    backend_kind = backend_selection.selected_sandbox_backend_kind()
    memory_view = configured_memory_material_view() if agent_memory_enabled() else None
    tmp_view = tmp_view_for_backend(backend_kind)
    material_views = [
        workspace_view(host_path=workspace_root, writable=True),
        read_only_material_view(agent_path="/history", host_path=history_path),
    ]
    if agent_skills_enabled():
        material_views.append(
            skill_view(host_path=materialize_agent_skills_view(SINGLE_AGENT_SKILLS))
        )
    if memory_view is not None:
        material_views.append(memory_view)
    if tmp_view is not None:
        material_views.append(tmp_view)

    return create_backend_with_materials(
        container_name_prefix="issue-single-agent",
        material_views=material_views,
        image=workspace_image,
        backend_kind=backend_kind,
    )


def build_issue_single_agent_system_prompt(
    *,
    review_objective: ReviewObjective,
    repair_mode: RepairMode = REPAIR_MODE_TEST_CHANGES_ALLOWED,
) -> str:
    paths = [
        "single-agent/system-core.md",
        f"review-objectives/{review_objective}/single-agent-delta.md",
        "scopes/issue/single-agent/system-delta.md",
        repair_mode_boundary_prompt_path(repair_mode),
    ]
    paths.extend(
        [
            "shared/no-git-history-remediation-boundary.md",
            "shared/runtime-evidence-discipline.md",
            "shared/validation-level-discipline.md",
            "shared/input-location-hints-rule.md",
            "shared/security-false-positive-precedents.md",
            "shared/workspace-evidence-rule.md",
        ]
    )
    return join_prompt_sections(paths)


def build_issue_single_agent_filesystem_system_prompt() -> str:
    return join_prompt_sections(
        [
            "single-agent/filesystem-system-core.md",
            "scopes/issue/single-agent/filesystem-system-delta.md",
        ]
    )


def build_issue_single_agent_todo_system_prompt() -> str:
    return load_prompt_resource("single-agent/todo-system.md")


def build_issue_single_agent_todo_tool_description() -> str:
    return load_prompt_resource("single-agent/todo-tool-description.md")


def build_issue_single_agent_user_prompt(*, issue: Mapping[str, Any]) -> str:
    title = issue.get("title")
    body = issue.get("body")
    return "\n".join(
        [
            ISSUE_SINGLE_AGENT_INITIAL_INTRO,
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
