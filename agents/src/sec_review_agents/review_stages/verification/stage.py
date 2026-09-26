"""Reusable verification stage runtime; workflows own review-specific prompts."""

import subprocess
import tempfile
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.verification.agent import (
    create_verification_agent_graph,
)
from sec_review_agents.review_stages.feedback_loop import MAX_FEEDBACK_RETRY_ATTEMPTS
from sec_review_agents.review_stages.verification.result import (
    build_verification_stage_result,
)
from sec_review_agents.run_artifacts.stage import reset_stage_attempt_artifacts
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.utils.files import persist_json
from sec_review_agents.workspace.snapshots import restore_workspace_from_snapshot_tar


def persist_verification_result(
    verifier_artifacts_path: Path,
    result: Any,
    *,
    attempt_label: str,
) -> None:
    persist_json(
        verifier_artifacts_path,
        "verification-result.json",
        result,
    )
    if attempt_label != "initial":
        persist_json(
            verifier_artifacts_path,
            f"verification-result.{attempt_label}.json",
            result,
        )


def verification_attempt_label(retry_context: Mapping[str, Any] | None) -> str:
    if isinstance(retry_context, Mapping):
        retry_index = retry_context.get("retry_index")
        if isinstance(retry_index, int) and retry_index >= 1:
            return f"retry-{retry_index}"
    return "initial"


def reset_verification_attempt_artifacts(
    verifier_artifacts_path: Path, *, attempt_label: str
) -> None:
    filenames = [
        "verification-result.json",
    ]
    if attempt_label != "initial":
        filenames.extend(
            [
                f"verification-result.{attempt_label}.json",
            ]
        )
    else:
        filenames.extend(
            [
                "verification-result.initial.json",
            ]
        )
        for retry_index in range(1, MAX_FEEDBACK_RETRY_ATTEMPTS + 1):
            retry_label = f"retry-{retry_index}"
            filenames.extend(
                [
                    f"verification-result.{retry_label}.json",
                ]
            )
    reset_stage_attempt_artifacts(
        verifier_artifacts_path,
        filenames=filenames,
    )
    if attempt_label == "initial":
        transcript_files = ["transcripts/initial.json"]
        transcript_files.extend(
            f"transcripts/retry-{retry_index}.json"
            for retry_index in range(1, MAX_FEEDBACK_RETRY_ATTEMPTS + 1)
        )
    else:
        transcript_files = [f"transcripts/{attempt_label}.json"]
    reset_stage_attempt_artifacts(
        verifier_artifacts_path,
        filenames=transcript_files,
    )


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
    structured_result: Mapping[str, Any], mitigation_result: Mapping[str, Any] | None
) -> None:
    patch_coverage = structured_result.get("patch_coverage")
    changed_files = (mitigation_result or {}).get("changed_files")
    if (
        isinstance(changed_files, list)
        and changed_files
        and patch_coverage
        in {
            "no-patch",
            "not-applicable",
        }
    ):
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
    published_transcript_path: Path | None = None,
    baseline_snapshot_tar_path: Path,
    workspace_patch: str | None,
    mitigation_result: Mapping[str, Any] | None,
    build_backend: Callable[[Path], Any],
    system_prompt: str,
    filesystem_system_prompt: str,
    user_prompt: str,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="sec-review-verifier-") as tempdir:
        local_transcript_path = (
            verifier_artifacts_path / "transcripts" / f"{attempt_label}.json"
        )
        transcript_paths: tuple[Path, ...] = (local_transcript_path,)
        if published_transcript_path is not None:
            published_transcript_path.unlink(missing_ok=True)
            transcript_paths = (local_transcript_path, published_transcript_path)

        workspace_path = Path(tempdir)
        restore_workspace_from_snapshot_tar(
            tar_path=baseline_snapshot_tar_path,
            destination_path=workspace_path,
        )
        _apply_workspace_patch(
            workspace_path=workspace_path,
            workspace_patch=workspace_patch,
        )
        backend = build_backend(workspace_path)
        # Keep backend lifetime around both agent construction and invocation; some
        # middleware resolves tools against backend resources during graph creation.
        async with amanaged_backend(backend):
            agent = await create_verification_agent_graph(
                agent_name=agent_name,
                backend=backend,
                system_prompt=system_prompt,
                filesystem_system_prompt=filesystem_system_prompt,
            )
            agent_output = await invoke_agent_runtime_graph(
                agent=agent,
                agent_name=agent_name,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                transcript_paths=transcript_paths,
            )

        validate_verification_coverages(agent_output, mitigation_result)
        result = build_verification_stage_result(
            overview=agent_output["overview"],
            review_target_claim=agent_output["review_target_claim"],
            patch_coverage=agent_output["patch_coverage"],
            resolution_next_step=agent_output["resolution_next_step"],
            patch_findings=agent_output["patch_findings"],
            verification_findings=agent_output["verification_findings"],
            validation_level=agent_output["validation_level"],
            regression_status=agent_output["regression_status"],
            residual_risks=agent_output["residual_risks"],
        )
        persist_verification_result(
            verifier_artifacts_path,
            result,
            attempt_label=attempt_label,
        )
        return result


__all__ = [
    "reset_verification_attempt_artifacts",
    "run_verification_stage",
    "verification_attempt_label",
]
