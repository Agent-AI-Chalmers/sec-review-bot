"""Reusable mitigation stage runtime; workflows own review-specific prompts."""

import tempfile
from collections.abc import Callable
from pathlib import Path

from sec_review_agents.agents.mitigation.agent import (
    run_mitigation_agent,
)
from sec_review_agents.filesystem.backend_factory import (
    BackendConfig,
    create_backend_with_path_views,
)
from sec_review_agents.memory.runtime_view import materialized_memory_view
from sec_review_agents.review_stages.feedback_loop import (
    MAX_FEEDBACK_RETRY_ATTEMPTS,
    FeedbackRetryContext,
)
from sec_review_agents.review_stages.mitigation.result import (
    MitigationStageResult,
    build_mitigation_stage_result,
    build_skipped_mitigation_result,
)
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.runtime.setup_bootstrap import (
    bootstrap_environment,
    record_bootstrap_result,
)
from sec_review_agents.runtime.trajectories import (
    remove_trajectories,
    trajectory_path,
)
from sec_review_agents.utils.files import (
    persist_json_artifact,
    persist_text_artifact,
    remove_json_artifacts,
    reset_stage_attempt_artifacts,
)
from sec_review_agents.workspace.patches import (
    build_patch_artifact,
)
from sec_review_agents.workspace.snapshots import (
    restore_workspace_from_snapshot_tar,
)


def persist_mitigation_result(
    mitigator_artifacts_path: Path,
    result: MitigationStageResult,
    *,
    attempt_label: str,
) -> None:
    """Persist the latest mitigation result and its retry-specific copy."""
    persist_json_artifact(
        mitigator_artifacts_path,
        "mitigation-result",
        result.model_dump(mode="json"),
    )
    if attempt_label != "initial":
        persist_json_artifact(
            mitigator_artifacts_path,
            f"mitigation-result.{attempt_label}",
            result.model_dump(mode="json"),
        )


def persist_mitigation_patch(
    mitigator_artifacts_path: Path,
    patch_diff: str,
    *,
    attempt_label: str,
) -> None:
    """Persist the latest workspace patch and its retry-specific copy."""
    persist_text_artifact(
        mitigator_artifacts_path,
        "workspace.patch",
        patch_diff,
    )
    if attempt_label != "initial":
        persist_text_artifact(
            mitigator_artifacts_path,
            f"workspace.{attempt_label}.patch",
            patch_diff,
        )


def mitigation_attempt_label(retry_context: FeedbackRetryContext | None) -> str:
    return (
        f"retry-{retry_context.retry_index}" if retry_context is not None else "initial"
    )


def reset_mitigation_attempt_artifacts(
    *,
    mitigator_artifacts_path: Path,
    attempt_label: str,
) -> None:
    json_stems = ["mitigation-result"]
    filenames = ["workspace.patch"]
    if attempt_label != "initial":
        json_stems.append(f"mitigation-result.{attempt_label}")
        filenames.append(f"workspace.{attempt_label}.patch")
    else:
        json_stems.append("mitigation-result.initial")
        filenames.append("workspace.initial.patch")
        for retry_index in range(1, MAX_FEEDBACK_RETRY_ATTEMPTS + 1):
            retry_label = f"retry-{retry_index}"
            json_stems.append(f"mitigation-result.{retry_label}")
            filenames.append(f"workspace.{retry_label}.patch")
    remove_json_artifacts(mitigator_artifacts_path, json_stems)
    reset_stage_attempt_artifacts(
        mitigator_artifacts_path,
        filenames=filenames,
    )
    trajectory_attempts = (
        ["initial"]
        + [
            f"retry-{retry_index}"
            for retry_index in range(1, MAX_FEEDBACK_RETRY_ATTEMPTS + 1)
        ]
        if attempt_label == "initial"
        else [attempt_label]
    )
    remove_trajectories(
        trajectory_path(
            mitigator_artifacts_path / "trajectories",
            name=trajectory_attempt,
        )
        for trajectory_attempt in trajectory_attempts
    )


#########################################################################
# ====================== Skip Path =======================================
#########################################################################
def create_skipped_mitigation_result(
    *,
    mitigator_artifacts_path: Path,
    retry_context: FeedbackRetryContext | None,
    reason: str,
) -> MitigationStageResult:
    attempt_label = mitigation_attempt_label(retry_context)
    reset_mitigation_attempt_artifacts(
        mitigator_artifacts_path=mitigator_artifacts_path,
        attempt_label=attempt_label,
    )
    # Skipped mitigation still emits the patch files expected by downstream
    # verifier/delivery contracts, but with empty content.
    persist_mitigation_patch(
        mitigator_artifacts_path,
        "",
        attempt_label=attempt_label,
    )
    result = build_skipped_mitigation_result(reason=reason)
    persist_mitigation_result(
        mitigator_artifacts_path, result, attempt_label=attempt_label
    )
    return result


#########################################################################
# ====================== Stage Execution =================================
#########################################################################
async def run_mitigation_stage(
    *,
    agent_name: str,
    mitigator_artifacts_path: Path,
    published_trajectory_path: Path | None = None,
    baseline_snapshot_tar_path: Path,
    retry_context: FeedbackRetryContext | None,
    build_backend_config: Callable[[Path], BackendConfig],
    system_prompt: str,
    filesystem_system_prompt: str,
    user_prompt: str,
    setup_declaration_content: str | None = None,
) -> MitigationStageResult:
    attempt_label = mitigation_attempt_label(retry_context)
    # The backend mounts both resources, so their lifetimes must cover backend
    # construction, graph construction, and the complete agent invocation.
    with (
        tempfile.TemporaryDirectory(prefix="sec-review-mitigation-") as tempdir,
        materialized_memory_view() as memory_path_view,
    ):
        reset_mitigation_attempt_artifacts(
            mitigator_artifacts_path=mitigator_artifacts_path,
            attempt_label=attempt_label,
        )
        workspace_path = Path(tempdir)
        restore_workspace_from_snapshot_tar(
            tar_path=baseline_snapshot_tar_path,
            destination_path=workspace_path,
        )
        trajectory_paths = prepare_mitigation_trajectory(
            mitigator_artifacts_path=mitigator_artifacts_path,
            published_trajectory_path=published_trajectory_path,
            attempt_label=attempt_label,
        )
        config = build_backend_config(workspace_path)
        if memory_path_view is not None:
            config["path_views"].append(memory_path_view)
        backend = create_backend_with_path_views(**config)
        # Keep backend lifetime around both agent construction and invocation; some
        # middleware resolves tools against backend resources during graph creation.
        async with amanaged_backend(backend):
            record_bootstrap_result(
                mitigator_artifacts_path,
                await bootstrap_environment(
                    backend, setup_declaration_content=setup_declaration_content
                ),
            )
            agent_output = await run_mitigation_agent(
                agent_name=agent_name,
                backend=backend,
                system_prompt=system_prompt,
                filesystem_system_prompt=filesystem_system_prompt,
                baseline_snapshot_tar_path=baseline_snapshot_tar_path,
                workspace_root_path=workspace_path,
                user_prompt=user_prompt,
                trajectory_paths=trajectory_paths,
                memory_enabled=memory_path_view is not None,
            )
        declared_patch_paths = agent_output.declared_changed_files
        patch_artifact = build_patch_artifact(
            workspace_path,
            include_paths=declared_patch_paths,
        )
        persist_mitigation_patch(
            mitigator_artifacts_path,
            patch_artifact.patch_diff,
            attempt_label=attempt_label,
        )
        result = build_mitigation_stage_result(
            overview=agent_output.overview,
            file_changes=patch_artifact.file_changes,
            patch_diff=patch_artifact.patch_diff,
        )
        persist_mitigation_result(
            mitigator_artifacts_path,
            result,
            attempt_label=attempt_label,
        )
        return result


def prepare_mitigation_trajectory(
    *,
    mitigator_artifacts_path: Path,
    published_trajectory_path: Path | None,
    attempt_label: str,
) -> tuple[Path, ...]:
    local_trajectory_path = trajectory_path(
        mitigator_artifacts_path / "trajectories",
        name=attempt_label,
    )
    if published_trajectory_path is None:
        return (local_trajectory_path,)

    published_trajectory_path.unlink(missing_ok=True)
    return (local_trajectory_path, published_trajectory_path)


__all__ = [
    "create_skipped_mitigation_result",
    "mitigation_attempt_label",
    "run_mitigation_stage",
]
