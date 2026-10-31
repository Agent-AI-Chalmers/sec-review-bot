"""Build and archive delivery execution input payloads."""

from collections.abc import Sequence
from pathlib import Path

from pydantic import BaseModel

from sec_review_agents.delivery_stages.model import (
    DeliveryCaseInput,
    DeliveryEntry,
)
from sec_review_agents.utils.env import int_env
from sec_review_agents.utils.files import persist_json_artifact
from sec_review_agents.workspace.file_changes import DeletedFileChange, UpsertFileChange

DELIVERY_PATCH_MAX_CONCURRENCY = 4


def resolve_delivery_patch_max_concurrency(delivery_count: int) -> int:
    if delivery_count <= 0:
        return 1
    configured = int_env("REPOSITORY_PATCH_SYNTHESIS_MAX_CONCURRENCY", None, minimum=1)
    if configured is not None:
        return min(delivery_count, configured)
    return min(delivery_count, DELIVERY_PATCH_MAX_CONCURRENCY)


class DeliveryPatchCase(BaseModel):
    """A case's proposed patch, used by both single and combined deliveries.

    Execution needs the patch and file contents, not the full review narrative.
    The preparation step projects these fields once from DeliveryCaseInput;
    synthesis renders them as reference patches rather than review verdicts.
    """

    case_id: str
    mitigator_file_changes: list[DeletedFileChange | UpsertFileChange]
    mitigator_patch_diff: str | None


class DeliveryExecutionItem(BaseModel):
    """One planned delivery and its available case patches.

    Index preserves the plan's ordering across concurrent completion. Case items
    follow the plan's case order and contain only cases retained for delivery.
    """

    index: int
    delivery: DeliveryEntry
    case_items: list[DeliveryPatchCase]


class DeliveryExecutionInput(BaseModel):
    """Prepared delivery work shared by local and Temporal execution.

    Single deliveries reuse case patches; combined deliveries need synthesis and
    its concurrency limit. Paths locate worker-local artifacts and the immutable
    baseline used to synthesize combined patches.
    """

    run_artifacts_root_path: str
    workspace_snapshot_tar_path: str
    max_concurrency: int
    deliveries: list[DeliveryEntry]
    keep_case_ids: list[str]
    single_delivery_execution_items: list[DeliveryExecutionItem]
    combined_delivery_execution_items: list[DeliveryExecutionItem]


def build_delivery_execution_input(
    *,
    run_artifacts_root: Path,
    workspace_snapshot_tar_path: Path,
    deliveries: Sequence[DeliveryEntry],
    keep_case_results: Sequence[DeliveryCaseInput],
) -> DeliveryExecutionInput:
    keep_case_results_by_case_id = {item.case_id: item for item in keep_case_results}
    delivery_items = list(deliveries)
    single_delivery_execution_items: list[DeliveryExecutionItem] = []
    combined_delivery_execution_items: list[DeliveryExecutionItem] = []
    for index, delivery_entry in enumerate(delivery_items):
        delivery_case_results = [
            keep_case_results_by_case_id[case_id]
            for case_id in delivery_entry.case_ids
            if case_id in keep_case_results_by_case_id
        ]
        delivery_request = DeliveryExecutionItem(
            index=index,
            delivery=delivery_entry,
            case_items=[
                DeliveryPatchCase(
                    case_id=item.case_id,
                    mitigator_file_changes=item.mitigator_file_changes,
                    mitigator_patch_diff=item.mitigator_patch_diff,
                )
                for item in delivery_case_results
            ],
        )
        if delivery_entry.strategy == "combined":
            combined_delivery_execution_items.append(delivery_request)
        else:
            single_delivery_execution_items.append(delivery_request)
    return DeliveryExecutionInput(
        run_artifacts_root_path=str(run_artifacts_root),
        workspace_snapshot_tar_path=str(workspace_snapshot_tar_path),
        max_concurrency=resolve_delivery_patch_max_concurrency(
            len(combined_delivery_execution_items)
        ),
        deliveries=delivery_items,
        keep_case_ids=[item.case_id for item in keep_case_results],
        single_delivery_execution_items=single_delivery_execution_items,
        combined_delivery_execution_items=combined_delivery_execution_items,
    )


def persist_delivery_execution_input(
    *,
    run_artifacts_root: Path,
    deliveries: Sequence[DeliveryEntry],
    keep_case_results: Sequence[DeliveryCaseInput],
) -> None:
    combined_delivery_count = sum(
        1 for item in deliveries if item.strategy == "combined"
    )
    execution_payload = {
        "summary": {
            "delivery_count": len(deliveries),
            "case_result_count": len(keep_case_results),
            "keep_case_count": len(keep_case_results),
            "combined_delivery_count": combined_delivery_count,
        },
        "deliveries": [item.model_dump(mode="json") for item in deliveries],
        "cases": [
            {
                "case_id": item.case_id,
                "disposition": item.disposition,
                "reason": item.reason,
            }
            for item in keep_case_results
        ],
    }
    persist_json_artifact(
        run_artifacts_root / "delivery-execution",
        "delivery-execution-input",
        execution_payload,
    )


__all__ = [
    "build_delivery_execution_input",
    "persist_delivery_execution_input",
    "resolve_delivery_patch_max_concurrency",
]
