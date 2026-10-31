"""Delivery result builders and artifact persistence."""

import re
from collections.abc import Sequence
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from sec_review_agents.delivery_stages.execution.result import DeliveryExecutionResult
from sec_review_agents.delivery_stages.model import (
    DeliveryEntry,
)
from sec_review_agents.utils.files import persist_json_artifact
from sec_review_agents.workspace.file_changes import DeletedFileChange, UpsertFileChange


class DeliveryArtifact(BaseModel):
    """Publishable patch and the reviewed cases it delivers."""

    delivery_id: str
    case_ids: list[str]
    patch_diff: str
    file_changes: list[DeletedFileChange | UpsertFileChange] = Field(
        default_factory=list
    )

    model_config = ConfigDict(extra="ignore")


class DeliveryResult(BaseModel):
    """Delivery-stage summary retained until artifact or public JSON projection.

    Only publishable patches appear here; individual execution failures remain
    execution outcomes rather than empty public deliveries.
    """

    status: str
    deliveries: list[DeliveryArtifact] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")


def _build_delivery_artifact(
    *,
    delivery_entry: DeliveryEntry,
    keep_case_ids: Sequence[str],
    patch_outcome: DeliveryExecutionResult,
) -> DeliveryArtifact | None:
    delivery_id = delivery_entry.delivery_id
    keep_case_id_set = set(keep_case_ids)
    case_ids = [
        case_id for case_id in delivery_entry.case_ids if case_id in keep_case_id_set
    ]
    if not delivery_id or not case_ids:
        return None

    file_changes = patch_outcome.file_changes
    if not (patch_outcome.status == "ready" and file_changes):
        return None

    return DeliveryArtifact(
        delivery_id=delivery_id,
        case_ids=case_ids,
        # Preserve the generated patch so consumers need no checkout to rebuild it.
        patch_diff=patch_outcome.patch_diff,
        file_changes=file_changes,
    )


def _build_delivery_artifacts(
    *,
    deliveries: Sequence[DeliveryEntry],
    keep_case_ids: Sequence[str],
    patch_outcomes: Sequence[DeliveryExecutionResult],
) -> list[DeliveryArtifact]:
    outcomes_by_delivery_id = {
        outcome.delivery_id: outcome for outcome in patch_outcomes
    }
    delivery_artifacts: list[DeliveryArtifact] = []
    for delivery_entry in deliveries:
        delivery_id = delivery_entry.delivery_id
        outcome = outcomes_by_delivery_id.get(delivery_id)
        if outcome is None:
            continue
        artifact = _build_delivery_artifact(
            delivery_entry=delivery_entry,
            keep_case_ids=keep_case_ids,
            patch_outcome=outcome,
        )
        if artifact is not None:
            delivery_artifacts.append(artifact)
    return delivery_artifacts


def build_delivery_result_from_outcomes(
    *,
    deliveries: Sequence[DeliveryEntry],
    keep_case_ids: Sequence[str],
    patch_outcomes: Sequence[DeliveryExecutionResult],
) -> DeliveryResult:
    delivery_results = _build_delivery_artifacts(
        deliveries=deliveries,
        keep_case_ids=keep_case_ids,
        patch_outcomes=patch_outcomes,
    )

    return DeliveryResult(status="completed", deliveries=delivery_results)


def build_skipped_delivery_result() -> DeliveryResult:
    return DeliveryResult(status="skipped", deliveries=[])


def persist_delivery_result(
    *,
    run_artifacts_root: Path,
    result: DeliveryResult,
) -> None:
    stage_artifacts_path = run_artifacts_root / "delivery-execution"
    for artifact in result.deliveries:
        delivery_artifacts_dir = stage_artifacts_path / "artifacts"
        delivery_artifacts_dir.mkdir(parents=True, exist_ok=True)
        delivery_id = artifact.delivery_id.strip()
        if not delivery_id:
            continue
        slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", delivery_id).strip("-")
        persist_json_artifact(
            delivery_artifacts_dir, slug or "delivery", artifact.model_dump(mode="json")
        )
    persist_json_artifact(
        stage_artifacts_path, "delivery-result", result.model_dump(mode="json")
    )


__all__ = [
    "build_delivery_result_from_outcomes",
    "build_skipped_delivery_result",
    "persist_delivery_result",
]
