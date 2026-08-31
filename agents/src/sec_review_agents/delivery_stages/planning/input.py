"""Prepare delivery planning input materials."""

from collections.abc import Sequence
from pathlib import Path
from typing import Any

from sec_review_agents.delivery_stages.model import DeliveryCaseInput


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
        case_id = item["case_id"]
        patch_diff = item.get("mitigator_patch_diff") or ""
        if not patch_diff:
            continue
        (patch_root / f"{case_id}.patch").write_text(patch_diff, encoding="utf-8")

    return patch_root


def build_delivery_planning_cases(
    case_results: Sequence[DeliveryCaseInput],
) -> list[dict[str, Any]]:
    return [
        {
            "case_id": item["case_id"],
            "overview": item["mitigation_overview"],
            "changed_files": sorted(item["mitigator_changed_files"]),
        }
        for item in case_results
    ]


__all__ = [
    "build_delivery_planning_cases",
    "prepare_delivery_planning_patch_view",
]
