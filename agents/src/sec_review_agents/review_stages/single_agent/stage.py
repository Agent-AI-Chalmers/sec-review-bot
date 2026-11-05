"""Reusable single-agent repair stage runtime; workflows own review-specific prompts."""

import tempfile
from collections.abc import Callable
from pathlib import Path

from sec_review_agents.agents.single_agent.agent import (
    run_single_agent,
)
from sec_review_agents.filesystem.backend_factory import (
    BackendConfig,
    create_backend_with_path_views,
)
from sec_review_agents.memory.runtime_view import materialized_memory_view
from sec_review_agents.review_stages.single_agent.result import (
    SingleAgentFixOutcome,
)
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.runtime.setup_bootstrap import (
    bootstrap_environment,
    record_bootstrap_result,
)
from sec_review_agents.runtime.trajectories import remove_trajectories, trajectory_path
from sec_review_agents.utils.files import (
    persist_text_artifact,
    reset_stage_attempt_artifacts,
)
from sec_review_agents.workspace.commits import (
    build_committed_patch,
    resolve_workspace_commit,
)
from sec_review_agents.workspace.snapshots import (
    restore_workspace_from_snapshot_tar,
)


async def run_single_agent_stage(
    *,
    agent_name: str,
    workspace_snapshot_tar_path: Path,
    single_agent_artifacts_path: Path,
    build_backend_config: Callable[[Path], BackendConfig],
    system_prompt: str,
    filesystem_system_prompt: str,
    user_prompt: str,
    todo_system_prompt: str,
    todo_tool_description: str,
    setup_declaration_content: str | None = None,
) -> SingleAgentFixOutcome:
    # The backend mounts both resources, so their lifetimes must cover backend
    # construction, graph construction, and the complete agent invocation.
    with (
        tempfile.TemporaryDirectory(prefix="sec-review-single-agent-") as tempdir,
        materialized_memory_view() as memory_path_view,
    ):
        reset_stage_attempt_artifacts(
            single_agent_artifacts_path,
            filenames=("workspace.patch",),
        )
        remove_trajectories((trajectory_path(single_agent_artifacts_path),))
        workspace_path = Path(tempdir)
        restore_workspace_from_snapshot_tar(
            tar_path=workspace_snapshot_tar_path,
            destination_path=workspace_path,
        )
        trajectory = trajectory_path(single_agent_artifacts_path)
        # Setup and the agent may move HEAD; delivery stays anchored to this seed.
        baseline_commit = resolve_workspace_commit(workspace_path)
        config = build_backend_config(workspace_path)
        workspace_root = config.get("working_directory", "/workspace")
        if memory_path_view is not None:
            config["path_views"].append(memory_path_view)
        backend = create_backend_with_path_views(**config)
        # Keep backend lifetime around both agent construction and invocation; some
        # middleware resolves tools against backend resources during graph creation.
        async with amanaged_backend(backend):
            record_bootstrap_result(
                single_agent_artifacts_path,
                await bootstrap_environment(
                    backend,
                    setup_declaration_content=setup_declaration_content,
                    workspace_root=workspace_root,
                ),
            )
            agent_output = await run_single_agent(
                agent_name=agent_name,
                backend=backend,
                system_prompt=system_prompt,
                filesystem_system_prompt=filesystem_system_prompt,
                workspace_root=workspace_root,
                todo_system_prompt=todo_system_prompt,
                todo_tool_description=todo_tool_description,
                baseline_commit=baseline_commit,
                workspace_snapshot_tar_path=workspace_snapshot_tar_path,
                workspace_root_path=workspace_path,
                user_prompt=user_prompt,
                trajectory_paths=(trajectory,),
                memory_enabled=memory_path_view is not None,
            )
        patch_artifact = build_committed_patch(
            workspace_path, baseline_commit=baseline_commit
        )
        persist_text_artifact(
            single_agent_artifacts_path,
            "workspace.patch",
            patch_artifact.patch_diff,
        )
        return SingleAgentFixOutcome(
            overview=agent_output.overview,
            verdict=agent_output.verdict,
            validation_level=agent_output.validation_level,
            regression=agent_output.regression,
            target_claim=agent_output.target_claim,
            file_changes=patch_artifact.file_changes,
            patch_diff=patch_artifact.patch_diff,
            residual_risks=agent_output.residual_risks,
            self_check_notes=agent_output.self_check_notes,
        )


__all__ = [
    "run_single_agent_stage",
]
