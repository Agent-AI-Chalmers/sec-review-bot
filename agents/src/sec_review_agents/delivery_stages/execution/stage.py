"""Execute individual delivery plan entries."""

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from sec_review_agents.delivery_stages.execution.input import (
    combined_delivery_case_view,
    delivery_strategy,
)
from sec_review_agents.delivery_stages.execution.patch_synthesis import (
    synthesize_combined_delivery_patch,
)
from sec_review_agents.delivery_stages.execution.result import (
    build_delivery_execution_result,
)
from sec_review_agents.delivery_stages.model import (
    DeliveryEntry,
)


def _build_single_delivery_outcome(
    *,
    delivery_entry: DeliveryEntry,
    case_results_by_case_id: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any] | None:
    delivery_id = delivery_entry["delivery_id"]
    case_ids = [
        case_id
        for case_id in delivery_entry["case_ids"]
        if case_id in case_results_by_case_id
    ]
    if not delivery_id or not case_ids:
        return None
    case_id = case_ids[0]

    case_result = case_results_by_case_id[case_id]
    patch_diff = case_result["mitigator_patch_diff"] or ""
    changed_files = case_result["mitigator_changed_files"]
    file_changes = case_result["mitigator_file_changes"]
    return build_delivery_execution_result(
        delivery_id=delivery_id,
        status="ready",
        error=None,
        changed_files=changed_files,
        file_changes=file_changes,
        patch_diff=patch_diff,
        applied_case_ids=[case_id],
        patch_path=None,
    )


async def execute_delivery_entry(
    *,
    run_artifacts_root: Path,
    delivery_entry: DeliveryEntry,
    case_results: Sequence[Mapping[str, Any]],
    baseline_snapshot_tar_path: Path | None = None,
) -> dict[str, Any] | None:
    case_results_by_case_id = {item["case_id"]: item for item in case_results}
    strategy = delivery_strategy(delivery_entry)
    if strategy == "single":
        return _build_single_delivery_outcome(
            delivery_entry=delivery_entry,
            case_results_by_case_id=case_results_by_case_id,
        )

    delivery_id = delivery_entry["delivery_id"]
    case_ids = [
        case_id
        for case_id in delivery_entry["case_ids"]
        if case_id in case_results_by_case_id
    ]
    if not delivery_id or not case_ids:
        return None
    if baseline_snapshot_tar_path is None:
        raise ValueError(
            "baseline_snapshot_tar_path is required for combined deliveries."
        )
    try:
        synthesis_result = await synthesize_combined_delivery_patch(
            baseline_snapshot_tar_path=baseline_snapshot_tar_path,
            patch_synthesis_root=run_artifacts_root / "patch-synthesis",
            delivery_entry=delivery_entry,
            case_items=[
                combined_delivery_case_view(case_results_by_case_id[case_id])
                for case_id in case_ids
            ],
        )
        return build_delivery_execution_result(
            delivery_id=delivery_id,
            status=synthesis_result["status"],
            error=synthesis_result.get("error"),
            changed_files=synthesis_result.get("changed_files") or [],
            file_changes=synthesis_result.get("file_changes") or [],
            patch_diff=str(synthesis_result.get("patch_diff") or ""),
            applied_case_ids=case_ids,
            patch_path=synthesis_result.get("patch_path"),
        )
    except Exception as error:
        return build_delivery_execution_result(
            delivery_id=delivery_id,
            status="failed",
            error=f"Patch synthesis failed: {error}",
            changed_files=[],
            file_changes=[],
            patch_diff="",
            applied_case_ids=case_ids,
            patch_path=None,
        )


__all__ = [
    "execute_delivery_entry",
]
