"""Reusable verification stage runtime; workflows own review-specific prompts."""

import tempfile
from collections.abc import Callable
from pathlib import Path

from sec_review_agents.agents.verification.agent import (
    run_verification_agent,
)
from sec_review_agents.agents.verification.model import VerificationOutput
from sec_review_agents.filesystem.backend_factory import (
    BackendConfig,
    create_backend_with_path_views,
)
from sec_review_agents.memory.runtime_view import materialized_memory_view
from sec_review_agents.review_stages.feedback_loop import (
    MAX_FEEDBACK_RETRY_ATTEMPTS,
    FeedbackRetryContext,
)
from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from sec_review_agents.review_stages.verification.result import (
    VerificationStageResult,
    build_skipped_verification_result,
    build_verification_stage_result,
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
    remove_json_artifacts,
)
from sec_review_agents.workspace.file_changes import file_change_paths
from sec_review_agents.workspace.patches import apply_workspace_patch
from sec_review_agents.workspace.snapshots import restore_workspace_from_snapshot_tar

# Stage execution


async def run_verification_stage(
    *,
    agent_name: str,
    verifier_artifacts_path: Path,
    attempt_label: str,
    published_trajectory_path: Path | None = None,
    workspace_snapshot_tar_path: Path,
    workspace_patch: str | None,
    mitigation_result: MitigationStageResult | None,
    build_backend_config: Callable[[Path], BackendConfig],
    system_prompt: str,
    filesystem_system_prompt: str,
    user_prompt: str,
    setup_declaration_content: str | None = None,
) -> VerificationStageResult:
    # The backend mounts both resources, so their lifetimes must cover backend
    # construction, graph construction, and the complete agent invocation.
    with (
        tempfile.TemporaryDirectory(prefix="sec-review-verifier-") as tempdir,
        materialized_memory_view() as memory_path_view,
    ):
        trajectory_paths = prepare_verification_trajectory(
            verifier_artifacts_path=verifier_artifacts_path,
            published_trajectory_path=published_trajectory_path,
            attempt_label=attempt_label,
        )

        workspace_path = Path(tempdir)
        restore_workspace_from_snapshot_tar(
            tar_path=workspace_snapshot_tar_path,
            destination_path=workspace_path,
        )
        apply_workspace_patch(workspace_path, workspace_patch)
        config = build_backend_config(workspace_path)
        workspace_root = config.get("working_directory", "/workspace")
        if memory_path_view is not None:
            config["path_views"].append(memory_path_view)
        backend = create_backend_with_path_views(**config)
        # Keep backend lifetime around both agent construction and invocation; some
        # middleware resolves tools against backend resources during graph creation.
        async with amanaged_backend(backend):
            record_bootstrap_result(
                verifier_artifacts_path,
                await bootstrap_environment(
                    backend,
                    setup_declaration_content=setup_declaration_content,
                    workspace_root=workspace_root,
                ),
            )
            agent_output = await run_verification_agent(
                agent_name=agent_name,
                backend=backend,
                system_prompt=system_prompt,
                filesystem_system_prompt=filesystem_system_prompt,
                workspace_root=workspace_root,
                user_prompt=user_prompt,
                trajectory_paths=trajectory_paths,
                memory_enabled=memory_path_view is not None,
            )

        validate_verification_coverages(agent_output, mitigation_result)
        result = build_verification_stage_result(
            overview=agent_output.overview,
            review_target_claim=agent_output.review_target_claim,
            patch_coverage=agent_output.patch_coverage,
            resolution_next_step=agent_output.resolution_next_step,
            patch_findings=agent_output.patch_findings,
            verification_findings=agent_output.verification_findings,
            validation_level=agent_output.validation_level,
            regression_status=agent_output.regression_status,
            residual_risks=agent_output.residual_risks,
        )
        persist_verification_result(
            verifier_artifacts_path,
            result,
            attempt_label=attempt_label,
        )
        return result


# Skip path


def create_skipped_verification_result(
    *,
    verifier_artifacts_path: Path,
    retry_context: FeedbackRetryContext | None,
    reason: str,
) -> VerificationStageResult:
    attempt_label = verification_attempt_label(retry_context)
    reset_verification_attempt_artifacts(
        verifier_artifacts_path,
        attempt_label=attempt_label,
    )
    result = build_skipped_verification_result(reason=reason)
    persist_verification_result(
        verifier_artifacts_path,
        result,
        attempt_label=attempt_label,
    )
    return result


# Preparation and cleanup


def verification_attempt_label(retry_context: FeedbackRetryContext | None) -> str:
    return (
        f"retry-{retry_context.retry_index}" if retry_context is not None else "initial"
    )


def reset_verification_attempt_artifacts(
    verifier_artifacts_path: Path, *, attempt_label: str
) -> None:
    json_stems = ["verification-result"]
    if attempt_label != "initial":
        json_stems.append(f"verification-result.{attempt_label}")
    else:
        json_stems.append("verification-result.initial")
        for retry_index in range(1, MAX_FEEDBACK_RETRY_ATTEMPTS + 1):
            retry_label = f"retry-{retry_index}"
            json_stems.append(f"verification-result.{retry_label}")
    remove_json_artifacts(verifier_artifacts_path, json_stems)
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
            verifier_artifacts_path / "trajectories",
            name=trajectory_attempt,
        )
        for trajectory_attempt in trajectory_attempts
    )


def prepare_verification_trajectory(
    *,
    verifier_artifacts_path: Path,
    published_trajectory_path: Path | None,
    attempt_label: str,
) -> tuple[Path, ...]:
    """Return local and optional published outputs for this verification attempt.

    Remove any old published copy; the runtime writer initializes the returned files.
    """
    local_trajectory_path = trajectory_path(
        verifier_artifacts_path / "trajectories",
        name=attempt_label,
    )
    if published_trajectory_path is None:
        return (local_trajectory_path,)

    published_trajectory_path.unlink(missing_ok=True)
    return (local_trajectory_path, published_trajectory_path)


# Result validation and persistence


def validate_verification_coverages(
    structured_result: VerificationOutput,
    mitigation_result: MitigationStageResult | None,
) -> None:
    patch_coverage = structured_result.patch_coverage
    changed_files = file_change_paths(
        mitigation_result.file_changes if mitigation_result is not None else None
    )
    if changed_files and patch_coverage in {
        "no-patch",
        "not-applicable",
    }:
        raise RuntimeError(
            "Verifier must evaluate the patch when mitigation exported changed files."
        )


def persist_verification_result(
    verifier_artifacts_path: Path,
    result: VerificationStageResult,
    *,
    attempt_label: str,
) -> None:
    persist_json_artifact(
        verifier_artifacts_path,
        "verification-result",
        result.model_dump(mode="json"),
    )
    if attempt_label != "initial":
        persist_json_artifact(
            verifier_artifacts_path,
            f"verification-result.{attempt_label}",
            result.model_dump(mode="json"),
        )


__all__ = [
    "create_skipped_verification_result",
    "reset_verification_attempt_artifacts",
    "run_verification_stage",
    "verification_attempt_label",
]
