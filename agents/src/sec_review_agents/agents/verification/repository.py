from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.verification.skills import VERIFICATION_AGENT_SKILLS
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
    render_history_projection_section,
    verification_feedback_retry_context,
    verifier_result_summary,
)
from sec_review_agents.runtime.runtime_config import (
    RunnerRuntimeContext,
    runtime_workspace_image,
)
from sec_review_agents.runtime.skills import materialize_agent_skills_view
from sec_review_agents.utils.markdown import code_block
from sec_review_agents.utils.structured_renderer import (
    render_structured_markdown_section,
)

REPOSITORY_VERIFICATION_INITIAL_INTRO = "\n".join(
    [
        "# Task",
        "",
        "Independently audit the current repository-case patch against the case statement, provided context, and current patch evidence.",
    ]
)

REPOSITORY_VERIFICATION_RETRY_INTRO = "\n".join(
    [
        "# Task",
        "",
        "Re-audit the revised repository-case patch against the carried-forward review target and provided retry context.",
    ]
)


def create_repository_verification_backend(
    *,
    workspace_root_path: Path,
    history_path: Path | None,
    incremental_window_path: Path | None,
    scan_mode: str,
    runtime_context: RunnerRuntimeContext | None = None,
):
    workspace_image = runtime_workspace_image(runtime_context)
    if not workspace_root_path.is_dir():
        raise FileNotFoundError(
            f"Verifier workspace does not exist: {workspace_root_path}"
        )
    backend_kind = backend_selection.selected_sandbox_backend_kind()
    memory_view = configured_memory_material_view() if agent_memory_enabled() else None
    tmp_view = tmp_view_for_backend(backend_kind)
    material_views = [
        workspace_view(host_path=workspace_root_path, writable=True),
    ]
    if agent_skills_enabled():
        material_views.append(
            skill_view(
                host_path=materialize_agent_skills_view(VERIFICATION_AGENT_SKILLS)
            )
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
        container_name_prefix="repository-verifier",
        material_views=material_views,
        image=workspace_image,
        backend_kind=backend_kind,
    )


def build_repository_verification_system_prompt(is_retry: bool = False) -> str:
    if is_retry:
        return join_prompt_sections(
            [
                "verifier/system-core.md",
                "verifier/system-retry-delta.md",
                "shared/no-git-history-remediation-boundary.md",
                "shared/runtime-evidence-discipline.md",
                "shared/validation-level-discipline.md",
                "shared/input-location-hints-rule.md",
                "scopes/repository/verifier/system-delta.md",
                "shared/workspace-evidence-rule.md",
                "shared/advisory-evidence-rule.md",
            ]
        )
    return join_prompt_sections(
        [
            "verifier/system-core.md",
            "verifier/system-initial-delta.md",
            "shared/no-git-history-remediation-boundary.md",
            "shared/runtime-evidence-discipline.md",
            "shared/validation-level-discipline.md",
            "shared/input-location-hints-rule.md",
            "scopes/repository/verifier/system-delta.md",
            "shared/workspace-evidence-rule.md",
            "shared/advisory-evidence-rule.md",
        ]
    )


def build_repository_verification_filesystem_system_prompt(
    scan_mode: str,
) -> str:
    paths = [
        "verifier/filesystem-system-core.md",
        "scopes/repository/verifier/filesystem-system-delta.md",
    ]
    if scan_mode == "incremental":
        paths.append("shared/incremental-evidence-rule.md")
    return join_prompt_sections(paths)


def build_repository_verification_user_prompt(
    *,
    review_input: str,
    scan_mode: str,
    retry_context: Mapping[str, Any] | None,
    analysis_result: Mapping[str, Any],
    mitigation_result: Mapping[str, Any] | None,
    workspace_patch: str | None,
) -> str:
    incremental_scope_rule = (
        load_prompt_resource("shared/incremental-window-scope-rule.md")
        if scan_mode == "incremental"
        else None
    )
    feedback_retry = verification_feedback_retry_context(retry_context)
    if isinstance(feedback_retry, dict):
        return _build_retry_repository_verification_user_prompt(
            review_input=review_input,
            mitigation_result=mitigation_result,
            workspace_patch=workspace_patch,
            incremental_scope_rule=incremental_scope_rule,
            feedback_retry=feedback_retry,
        )

    return _build_initial_repository_verification_user_prompt(
        review_input=review_input,
        analysis_result=analysis_result,
        mitigation_result=mitigation_result,
        workspace_patch=workspace_patch,
        incremental_scope_rule=incremental_scope_rule,
    )


def _mitigation_summary(
    mitigation_result: Mapping[str, Any] | None,
) -> dict[str, Any]:
    return {
        "overview": (mitigation_result or {}).get("overview"),
        "changed_files": (mitigation_result or {}).get("changed_files") or [],
    }


def _build_initial_repository_verification_user_prompt(
    *,
    review_input: str,
    analysis_result: Mapping[str, Any],
    mitigation_result: Mapping[str, Any] | None,
    workspace_patch: str | None,
    incremental_scope_rule: str | None,
) -> str:
    sections = [REPOSITORY_VERIFICATION_INITIAL_INTRO]
    if incremental_scope_rule:
        sections.extend(["", incremental_scope_rule])
    sections.extend(
        [
            "",
            review_input,
            "",
            render_structured_markdown_section(
                "Analysis Summary",
                {
                    "overview": str(analysis_result.get("overview") or "").strip()
                    or "(missing)",
                    "verdict": analysis_result.get("verdict"),
                },
                profile="prompt",
            ),
            "",
            render_structured_markdown_section(
                "Mitigation Summary",
                _mitigation_summary(mitigation_result),
                profile="prompt",
            ),
        ]
    )
    if isinstance(workspace_patch, str) and workspace_patch:
        sections.extend(
            ["", "# Workspace Patch", "", code_block("diff", workspace_patch)]
        )
    return "\n".join(sections)


def _build_retry_repository_verification_user_prompt(
    *,
    review_input: str,
    mitigation_result: Mapping[str, Any] | None,
    workspace_patch: str | None,
    incremental_scope_rule: str | None,
    feedback_retry: Mapping[str, Any],
) -> str:
    latest_verifier = feedback_retry.get("latest_verifier")
    history = feedback_retry.get("history")

    sections = [REPOSITORY_VERIFICATION_RETRY_INTRO]
    if incremental_scope_rule:
        sections.extend(["", incremental_scope_rule])
    sections.extend(
        [
            "",
            review_input,
            "",
            render_structured_markdown_section(
                "New Mitigation Summary",
                _mitigation_summary(mitigation_result),
                profile="prompt",
            ),
        ]
    )
    if isinstance(workspace_patch, str) and workspace_patch:
        sections.extend(
            ["", "# Workspace Patch", "", code_block("diff", workspace_patch)]
        )
    latest_verifier_summary = verifier_result_summary(latest_verifier)
    if latest_verifier_summary is not None:
        sections.extend(
            [
                "",
                render_structured_markdown_section(
                    "Previous Verifier Result",
                    dict(latest_verifier_summary),
                    profile="prompt",
                ),
            ]
        )
    history_section = render_history_projection_section(history)
    if history_section:
        sections.extend(["", history_section])
    return "\n".join(sections)
