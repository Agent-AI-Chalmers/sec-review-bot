"""Prepare delivery planning input materials."""

from collections.abc import Sequence
from pathlib import Path

from pydantic import BaseModel

from sec_review_agents.delivery_stages.model import DeliveryCaseInput
from sec_review_agents.workspace.file_changes import file_change_paths


class DeliveryPlanningCase(BaseModel):
    """Compact case information used to batch and plan deliveries.

    Planning needs the mitigation overview and changed paths, while patch bytes
    stay in the prepared patch view. Serialize this projection only when writing
    planning artifacts or populating the agent's workbench.
    """

    case_id: str
    overview: str
    changed_files: list[str]


def prepare_delivery_planning_patch_view(
    *,
    run_artifacts_root: Path,
    case_results: Sequence[DeliveryCaseInput],
) -> Path:
    patch_root = run_artifacts_root / "delivery-planning" / "patches"
    patch_root.mkdir(parents=True, exist_ok=True)

    for existing in patch_root.glob("*.patch"):
        existing.unlink()

    for item in case_results:
        case_id = item.case_id
        patch_diff = item.mitigator_patch_diff or ""
        if not patch_diff:
            continue
        (patch_root / f"{case_id}.patch").write_text(patch_diff, encoding="utf-8")

    return patch_root


def build_delivery_planning_cases(
    case_results: Sequence[DeliveryCaseInput],
) -> list[DeliveryPlanningCase]:
    return [
        DeliveryPlanningCase(
            case_id=item.case_id,
            overview=item.mitigation_overview,
            changed_files=sorted(file_change_paths(item.mitigator_file_changes)),
        )
        for item in case_results
    ]


__all__ = [
    "DeliveryPlanningCase",
    "build_delivery_planning_cases",
    "prepare_delivery_planning_patch_view",
]
