"""Reusable mitigation stage runtime; workflows own review-specific prompts."""

import tempfile
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.mitigation.agent import (
    create_mitigation_agent_graph,
)
from sec_review_agents.review_stages.feedback_loop import MAX_FEEDBACK_RETRY_ATTEMPTS
from sec_review_agents.review_stages.mitigation.result import (
    build_mitigation_stage_result,
    build_skipped_mitigation_result,
)
from sec_review_agents.run_artifacts.stage import reset_stage_attempt_artifacts
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.utils.files import persist_json, persist_text_artifact
from sec_review_agents.workspace.patches import (
    normalize_declared_changed_files,
    persist_workspace_patch,
)
from sec_review_agents.workspace.snapshots import (
    restore_workspace_from_snapshot_tar,
)


def persist_mitigation_result(
    mitigator_artifacts_path: Path,
    result: Any,
    *,
    attempt_label: str,
) -> None:
    persist_json(
        mitigator_artifacts_path,
        "mitigation-result.json",
        result,
    )
    if attempt_label != "initial":
        persist_json(
            mitigator_artifacts_path,
            f"mitigation-result.{attempt_label}.json",
            result,
        )


def mitigation_attempt_label(retry_context: Mapping[str, Any] | None) -> str:
    if isinstance(retry_context, Mapping):
        retry_index = retry_context.get("retry_index")
        if isinstance(retry_index, int) and retry_index >= 1:
            return f"retry-{retry_index}"
    return "initial"


def reset_mitigation_attempt_artifacts(
    *,
    mitigator_artifacts_path: Path,
    attempt_label: str,
) -> None:
    filenames = [
        "mitigation-result.json",
        "workspace.patch",
    ]
    if attempt_label != "initial":
        filenames.extend(
            [
                f"mitigation-result.{attempt_label}.json",
                f"workspace.{attempt_label}.patch",
            ]
        )
    else:
        filenames.extend(
            [
                "mitigation-result.initial.json",
                "workspace.initial.patch",
            ]
        )
        for retry_index in range(1, MAX_FEEDBACK_RETRY_ATTEMPTS + 1):
            retry_label = f"retry-{retry_index}"
            filenames.extend(
                [
                    f"mitigation-result.{retry_label}.json",
                    f"workspace.{retry_label}.patch",
                ]
            )
    reset_stage_attempt_artifacts(
        mitigator_artifacts_path,
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
        mitigator_artifacts_path,
        filenames=transcript_files,
    )


#########################################################################
# ====================== Skip Path =======================================
#########################################################################
def create_skipped_mitigation_result(
    *,
    mitigator_artifacts_path: Path,
    retry_context: Mapping[str, Any] | None,
    reason: str,
) -> dict[str, Any]:
    attempt_label = mitigation_attempt_label(retry_context)
    reset_mitigation_attempt_artifacts(
        mitigator_artifacts_path=mitigator_artifacts_path,
        attempt_label=attempt_label,
    )
    # Skipped mitigation still emits the patch files expected by downstream
    # verifier/delivery contracts, but with empty content.
    persist_text_artifact(mitigator_artifacts_path, "workspace.patch", "")
    if attempt_label != "initial":
        persist_text_artifact(
            mitigator_artifacts_path,
            f"workspace.{attempt_label}.patch",
            "",
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
    published_transcript_path: Path | None = None,
    baseline_snapshot_tar_path: Path,
    retry_context: Mapping[str, Any] | None,
    build_backend: Callable[[Path], Any],
    system_prompt: str,
    filesystem_system_prompt: str,
    user_prompt: str,
) -> dict[str, Any]:
    attempt_label = mitigation_attempt_label(retry_context)
    with tempfile.TemporaryDirectory(prefix="sec-review-mitigation-") as tempdir:
        reset_mitigation_attempt_artifacts(
            mitigator_artifacts_path=mitigator_artifacts_path,
            attempt_label=attempt_label,
        )
        workspace_path = Path(tempdir)
        restore_workspace_from_snapshot_tar(
            tar_path=baseline_snapshot_tar_path,
            destination_path=workspace_path,
        )
        transcript_paths = prepare_mitigation_transcript(
            mitigator_artifacts_path=mitigator_artifacts_path,
            published_transcript_path=published_transcript_path,
            attempt_label=attempt_label,
        )
        backend = build_backend(workspace_path)
        # Keep backend lifetime around both agent construction and invocation; some
        # middleware resolves tools against backend resources during graph creation.
        async with amanaged_backend(backend):
            agent = await create_mitigation_agent_graph(
                agent_name=agent_name,
                backend=backend,
                system_prompt=system_prompt,
                filesystem_system_prompt=filesystem_system_prompt,
                baseline_snapshot_tar_path=baseline_snapshot_tar_path,
                workspace_root_path=workspace_path,
            )
            agent_output = await invoke_agent_runtime_graph(
                agent=agent,
                agent_name=agent_name,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                transcript_paths=transcript_paths,
            )
        raw_declared_paths = agent_output.get("declared_changed_files")
        if raw_declared_paths is None:
            declared_patch_paths: list[str] = []
        elif isinstance(raw_declared_paths, list):
            declared_patch_paths = normalize_declared_changed_files(raw_declared_paths)
        else:
            raise ValueError("declared_changed_files must be a list.")
        patch_artifact = persist_mitigation_patch(
            declared_patch_paths=declared_patch_paths,
            workspace_path=workspace_path,
            mitigator_artifacts_path=mitigator_artifacts_path,
            attempt_label=attempt_label,
        )
        result = build_mitigation_stage_result(
            overview=agent_output["overview"],
            changed_files=patch_artifact["changed_files"],
            file_changes=patch_artifact.get("file_changes", []),
            patch_diff=str(patch_artifact.get("patch_diff") or ""),
        )
        persist_mitigation_result(
            mitigator_artifacts_path,
            result,
            attempt_label=attempt_label,
        )
        return result


def prepare_mitigation_transcript(
    *,
    mitigator_artifacts_path: Path,
    published_transcript_path: Path | None,
    attempt_label: str,
) -> tuple[Path, ...]:
    local_transcript_path = (
        mitigator_artifacts_path / "transcripts" / f"{attempt_label}.json"
    )
    if published_transcript_path is None:
        return (local_transcript_path,)

    published_transcript_path.unlink(missing_ok=True)
    return (local_transcript_path, published_transcript_path)


def persist_mitigation_patch(
    *,
    declared_patch_paths: list[str],
    workspace_path: Path,
    mitigator_artifacts_path: Path,
    attempt_label: str,
) -> dict[str, Any]:
    patch_artifact = persist_workspace_patch(
        workspace_path,
        patch_root_path=mitigator_artifacts_path,
        include_paths=declared_patch_paths,
    )
    if attempt_label != "initial":
        persist_text_artifact(
            mitigator_artifacts_path,
            f"workspace.{attempt_label}.patch",
            str(patch_artifact.get("patch_diff") or ""),
        )
    return patch_artifact


__all__ = [
    "create_skipped_mitigation_result",
    "mitigation_attempt_label",
    "run_mitigation_stage",
]
