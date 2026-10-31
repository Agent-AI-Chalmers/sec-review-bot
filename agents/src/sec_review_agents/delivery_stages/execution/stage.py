"""Execute individual delivery plan entries."""

from collections.abc import Mapping, Sequence
from pathlib import Path

from sec_review_agents.delivery_stages.execution.input import (
    DeliveryPatchCase,
)
from sec_review_agents.delivery_stages.execution.patch_synthesis import (
    synthesize_combined_delivery_patch,
)
from sec_review_agents.delivery_stages.execution.result import (
    DeliveryExecutionResult,
    build_delivery_execution_result,
)
from sec_review_agents.delivery_stages.model import (
    DeliveryEntry,
)


def _build_single_delivery_outcome(
    *,
    delivery_entry: DeliveryEntry,
    case_results_by_case_id: Mapping[str, DeliveryPatchCase],
) -> DeliveryExecutionResult | None:
    delivery_id = delivery_entry.delivery_id
    case_ids = [
        case_id
        for case_id in delivery_entry.case_ids
        if case_id in case_results_by_case_id
    ]
    if not delivery_id or not case_ids:
        return None
    case_id = case_ids[0]

    case_result = case_results_by_case_id[case_id]
    patch_diff = case_result.mitigator_patch_diff or ""
    file_changes = case_result.mitigator_file_changes
    has_changes = bool(file_changes)
    return build_delivery_execution_result(
        delivery_id=delivery_id,
        status="ready" if has_changes else "no-changes",
        error=None if has_changes else "Single delivery has no file changes.",
        file_changes=file_changes,
        patch_diff=patch_diff,
    )


async def execute_delivery_entry(
    *,
    run_artifacts_root: Path,
    delivery_entry: DeliveryEntry,
    case_results: Sequence[DeliveryPatchCase],
    baseline_snapshot_tar_path: Path | None = None,
) -> DeliveryExecutionResult | None:
    case_results_by_case_id = {item.case_id: item for item in case_results}
    strategy = delivery_entry.strategy
    if strategy == "single":
        return _build_single_delivery_outcome(
            delivery_entry=delivery_entry,
            case_results_by_case_id=case_results_by_case_id,
        )

    delivery_id = delivery_entry.delivery_id
    case_ids = [
        case_id
        for case_id in delivery_entry.case_ids
        if case_id in case_results_by_case_id
    ]
    if not delivery_id or not case_ids:
        return None
    if baseline_snapshot_tar_path is None:
        raise ValueError(
            "baseline_snapshot_tar_path is required for combined deliveries."
        )
    try:
        patch_artifact = await synthesize_combined_delivery_patch(
            baseline_snapshot_tar_path=baseline_snapshot_tar_path,
            patch_synthesis_root=run_artifacts_root / "patch-synthesis",
            delivery_entry=delivery_entry,
            case_items=[case_results_by_case_id[case_id] for case_id in case_ids],
        )
        file_changes = patch_artifact.file_changes
        has_changes = bool(file_changes)
        return build_delivery_execution_result(
            delivery_id=delivery_id,
            status="ready" if has_changes else "no-changes",
            error=(
                None
                if has_changes
                else "Patch synthesis produced no delivery file changes."
            ),
            file_changes=file_changes,
            patch_diff=patch_artifact.patch_diff,
        )
    except Exception as error:
        return build_delivery_execution_result(
            delivery_id=delivery_id,
            status="failed",
            error=f"Patch synthesis failed: {error}",
            file_changes=[],
            patch_diff="",
        )


__all__ = [
    "execute_delivery_entry",
]
