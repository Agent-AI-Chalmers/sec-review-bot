"""Reusable verification stage runtime; workflows own review-specific prompts."""

import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from sec_review_agents.agents.verification.agent import (
    run_verification_agent,
)
from sec_review_agents.filesystem.backend_factory import (
    BackendConfig,
    create_backend_with_path_views,
)
from sec_review_agents.agents.verification.model import VerificationOutput
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
from sec_review_agents.workspace.snapshots import restore_workspace_from_snapshot_tar


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


def _apply_workspace_patch(
    *,
    workspace_path: Path,
    workspace_patch: str | None,
) -> None:
    patch_content = (
        workspace_patch if workspace_patch and workspace_patch.strip() else None
    )
    if not patch_content:
        return

    patch_copy_path = workspace_path.parent / f"{workspace_path.name}.workspace.patch"
    try:
        patch_copy_path.write_text(patch_content, encoding="utf-8")

        # `git apply` exits 0 while skipping every path when the workspace sits inside
        # another repository, which would leave the verifier on the unpatched baseline
        # and report success. `--numstat` prints one line per file the patch resolves to,
        # so empty output with a zero exit code is exactly that silent skip; a malformed
        # patch exits non-zero and falls through to `--check` for its real message.
        stat_process = subprocess.run(
            ["git", "apply", "--numstat", "-p1", str(patch_copy_path)],
            cwd=workspace_path,
            capture_output=True,
            text=True,
            check=False,
        )
        if stat_process.returncode == 0 and not stat_process.stdout.strip():
            raise RuntimeError(
                "workspace.patch resolves to no file in the verifier workspace."
            )

        check_process = subprocess.run(
            ["git", "apply", "--check", "-p1", str(patch_copy_path)],
            cwd=workspace_path,
            capture_output=True,
            text=True,
            check=False,
        )
        if check_process.returncode != 0:
            raise RuntimeError(
                check_process.stderr.strip()
                or check_process.stdout.strip()
                or "Failed to validate workspace.patch against verifier workspace."
            )

        apply_process = subprocess.run(
            ["git", "apply", "-p1", str(patch_copy_path)],
            cwd=workspace_path,
            capture_output=True,
            text=True,
            check=False,
        )
        if apply_process.returncode != 0:
            raise RuntimeError(
                apply_process.stderr.strip()
                or apply_process.stdout.strip()
                or "Failed to apply workspace.patch to verifier workspace."
            )
    finally:
        patch_copy_path.unlink(missing_ok=True)


#########################################################################
# ====================== Result Normalization And Validation ============
#########################################################################
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


#########################################################################
# ====================== Stage Execution =================================
#########################################################################
async def run_verification_stage(
    *,
    agent_name: str,
    verifier_artifacts_path: Path,
    attempt_label: str,
    published_trajectory_path: Path | None = None,
    baseline_snapshot_tar_path: Path,
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
        local_trajectory_path = trajectory_path(
            verifier_artifacts_path / "trajectories",
            name=attempt_label,
        )
        trajectory_paths: tuple[Path, ...] = (local_trajectory_path,)
        if published_trajectory_path is not None:
            published_trajectory_path.unlink(missing_ok=True)
            trajectory_paths = (local_trajectory_path, published_trajectory_path)

        workspace_path = Path(tempdir)
        restore_workspace_from_snapshot_tar(
            tar_path=baseline_snapshot_tar_path,
            destination_path=workspace_path,
        )
        _apply_workspace_patch(
            workspace_path=workspace_path,
            workspace_patch=workspace_patch,
        )
        config = build_backend_config(workspace_path)
        if memory_path_view is not None:
            config["path_views"].append(memory_path_view)
        backend = create_backend_with_path_views(**config)
        # Keep backend lifetime around both agent construction and invocation; some
        # middleware resolves tools against backend resources during graph creation.
        async with amanaged_backend(backend):
            record_bootstrap_result(
                verifier_artifacts_path,
                await bootstrap_environment(
                    backend, setup_declaration_content=setup_declaration_content
                ),
            )
            agent_output = await run_verification_agent(
                agent_name=agent_name,
                backend=backend,
                system_prompt=system_prompt,
                filesystem_system_prompt=filesystem_system_prompt,
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


__all__ = [
    "create_skipped_verification_result",
    "reset_verification_attempt_artifacts",
    "run_verification_stage",
    "verification_attempt_label",
]
