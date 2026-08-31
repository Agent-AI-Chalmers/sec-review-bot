"""Delivery result builders and artifact persistence."""

import re
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from sec_review_agents.delivery_stages.model import (
    DeliveryEntry,
)
from sec_review_agents.utils.files import persist_json
from sec_review_agents.workspace.file_changes import FileChange


class DeliveryArtifact(BaseModel):
    delivery_id: str
    case_ids: list[str]
    file_changes: list[FileChange] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")


class DeliveryResult(BaseModel):
    status: str
    deliveries: list[DeliveryArtifact] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")


def _build_delivery_artifact(
    *,
    delivery_entry: DeliveryEntry,
    keep_case_ids: Sequence[str],
    patch_outcome: Mapping[str, Any],
) -> dict[str, Any] | None:
    delivery_id = delivery_entry["delivery_id"]
    keep_case_id_set = set(keep_case_ids)
    case_ids = [
        case_id for case_id in delivery_entry["case_ids"] if case_id in keep_case_id_set
    ]
    if not delivery_id or not case_ids:
        return None

    file_changes = patch_outcome.get("file_changes") or []
    if not (patch_outcome["status"] == "ready" and file_changes):
        return None

    return {
        "delivery_id": delivery_id,
        "case_ids": case_ids,
        "file_changes": file_changes,
    }


def _build_delivery_artifacts(
    *,
    deliveries: Sequence[DeliveryEntry],
    keep_case_ids: Sequence[str],
    patch_outcomes: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    outcomes_by_delivery_id = {
        outcome["delivery_id"]: outcome for outcome in patch_outcomes
    }
    delivery_artifacts: list[dict[str, Any]] = []
    for delivery_entry in deliveries:
        delivery_id = delivery_entry["delivery_id"]
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
    patch_outcomes: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    delivery_results = _build_delivery_artifacts(
        deliveries=deliveries,
        keep_case_ids=keep_case_ids,
        patch_outcomes=patch_outcomes,
    )

    return DeliveryResult.model_validate(
        {
            "status": "completed",
            "deliveries": delivery_results,
        }
    ).model_dump(mode="json")


def build_skipped_delivery_result() -> dict[str, Any]:
    return DeliveryResult.model_validate(
        {
            "status": "skipped",
            "deliveries": [],
        }
    ).model_dump(mode="json")


def persist_delivery_result(
    *,
    run_artifacts_root: Path,
    result: Mapping[str, Any],
) -> None:
    stage_artifacts_path = run_artifacts_root / "delivery-execution"
    for artifact in result.get("deliveries") or []:
        delivery_artifacts_dir = stage_artifacts_path / "artifacts"
        delivery_artifacts_dir.mkdir(parents=True, exist_ok=True)
        delivery_id = str(artifact.get("delivery_id") or "").strip()
        if not delivery_id:
            continue
        slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", delivery_id).strip("-")
        persist_json(delivery_artifacts_dir, f"{slug or 'delivery'}.json", artifact)
    persist_json(stage_artifacts_path, "delivery-result.json", result)


__all__ = [
    "build_delivery_result_from_outcomes",
    "build_skipped_delivery_result",
    "persist_delivery_result",
]
