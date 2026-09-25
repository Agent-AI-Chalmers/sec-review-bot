"""Reusable single-agent repair stage runtime; workflows own review-specific prompts."""

import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from sec_review_agents.agents.single_agent.agent import (
    create_single_agent_graph,
)
from sec_review_agents.review_stages.single_agent.result import (
    build_single_agent_fix_outcome,
)
from sec_review_agents.run_artifacts.stage import reset_stage_attempt_artifacts
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import managed_backend
from sec_review_agents.workspace.patches import (
    normalize_declared_changed_files,
    persist_workspace_patch,
)
from sec_review_agents.workspace.snapshots import (
    restore_workspace_from_snapshot_tar,
)


def _build_completed_single_agent_outcome(
    *,
    agent_output: dict,
    changed_files: list[str],
    file_changes: list[dict[str, Any]],
    patch_diff: str,
) -> dict[str, Any]:
    return build_single_agent_fix_outcome(
        overview=agent_output["overview"],
        verdict=agent_output["verdict"],
        validation_level=agent_output["validation_level"],
        regression_status=agent_output["regression_status"],
        target_claim=agent_output["target_claim"],
        changed_files=changed_files,
        file_changes=file_changes,
        patch_diff=patch_diff,
        residual_risks=agent_output["residual_risks"],
        self_check_notes=agent_output["self_check_notes"],
    )


async def run_single_agent_stage(
    *,
    agent_name: str,
    baseline_snapshot_tar_path: Path,
    single_agent_artifacts_path: Path,
    build_backend: Callable[[Path], Any],
    system_prompt: str,
    filesystem_system_prompt: str,
    user_prompt: str,
    todo_system_prompt: str,
    todo_tool_description: str,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="sec-review-single-agent-") as tempdir:
        reset_stage_attempt_artifacts(
            single_agent_artifacts_path,
            filenames=("workspace.patch", "transcript.json"),
        )
        workspace_path = Path(tempdir)
        restore_workspace_from_snapshot_tar(
            tar_path=baseline_snapshot_tar_path,
            destination_path=workspace_path,
        )
        transcript_path = single_agent_artifacts_path / "transcript.json"
        backend = build_backend(workspace_path)
        # Keep backend lifetime around both agent construction and invocation; some
        # middleware resolves tools against backend resources during graph creation.
        with managed_backend(backend):
            agent = await create_single_agent_graph(
                agent_name=agent_name,
                backend=backend,
                system_prompt=system_prompt,
                filesystem_system_prompt=filesystem_system_prompt,
                todo_system_prompt=todo_system_prompt,
                todo_tool_description=todo_tool_description,
                baseline_snapshot_tar_path=baseline_snapshot_tar_path,
                workspace_root_path=workspace_path,
            )
            agent_output = await invoke_agent_runtime_graph(
                agent=agent,
                agent_name=agent_name,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                transcript_paths=(transcript_path,),
            )
        raw_declared_paths = agent_output.get("declared_changed_files")
        if raw_declared_paths is None:
            declared_patch_paths: list[str] = []
        elif isinstance(raw_declared_paths, list):
            declared_patch_paths = normalize_declared_changed_files(raw_declared_paths)
        else:
            raise ValueError("declared_changed_files must be a list.")
        patch_artifact = persist_workspace_patch(
            workspace_path,
            patch_root_path=single_agent_artifacts_path,
            include_paths=declared_patch_paths,
        )
        return build_single_agent_stage_outcome(
            agent_output=agent_output,
            patch_artifact=patch_artifact,
        )


def build_single_agent_stage_outcome(
    *,
    agent_output: dict[str, Any],
    patch_artifact: dict[str, Any],
) -> dict[str, Any]:
    return _build_completed_single_agent_outcome(
        agent_output=agent_output,
        changed_files=patch_artifact["changed_files"],
        file_changes=patch_artifact.get("file_changes", []),
        patch_diff=str(patch_artifact.get("patch_diff") or ""),
    )


__all__ = [
    "run_single_agent_stage",
]
