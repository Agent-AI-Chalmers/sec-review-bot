"""Build and archive delivery execution input payloads."""

import os
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from sec_review_agents.delivery_stages.model import (
    DeliveryCaseInput,
    DeliveryEntry,
    DeliveryStrategy,
)
from sec_review_agents.utils.env import parse_int_env
from sec_review_agents.utils.files import persist_json

DELIVERY_PATCH_MAX_CONCURRENCY = 4
DELIVERY_STRATEGIES = {"single", "combined"}


def resolve_delivery_patch_max_concurrency(delivery_count: int) -> int:
    if delivery_count <= 0:
        return 1
    configured = parse_int_env(
        os.environ.get("REPOSITORY_PATCH_SYNTHESIS_MAX_CONCURRENCY")
    )
    if configured is not None:
        return max(1, min(delivery_count, configured))
    return min(delivery_count, DELIVERY_PATCH_MAX_CONCURRENCY)


def delivery_strategy(delivery_entry: DeliveryEntry) -> DeliveryStrategy:
    strategy = delivery_entry.get("strategy")
    if strategy not in DELIVERY_STRATEGIES:
        raise ValueError(f"Unknown delivery strategy: {strategy!r}.")
    return strategy


def single_delivery_case_view(case_result: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "case_id": case_result["case_id"],
        "mitigator_changed_files": case_result["mitigator_changed_files"],
        "mitigator_file_changes": case_result["mitigator_file_changes"],
        "mitigator_patch_diff": case_result["mitigator_patch_diff"],
    }


def combined_delivery_case_view(case_result: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "case_id": case_result["case_id"],
        "analyzer_overview": case_result["analyzer_overview"],
        "analyzer_verdict": case_result["analyzer_verdict"],
        "mitigator_changed_files": case_result["mitigator_changed_files"],
        "mitigator_patch_diff": case_result["mitigator_patch_diff"],
        "verifier_overview": case_result["verifier_overview"],
        "verifier_coverage": case_result["verifier_coverage"],
        "verifier_patch_findings": case_result["verifier_patch_findings"],
        "verifier_findings": case_result["verifier_findings"],
        "residual_risks": case_result["residual_risks"],
    }


def build_delivery_execution_input(
    *,
    run_artifacts_root: Path,
    workspace_snapshot_tar_path: Path,
    deliveries: Sequence[DeliveryEntry],
    keep_case_results: Sequence[DeliveryCaseInput],
) -> dict[str, Any]:
    keep_case_results_by_case_id = {item["case_id"]: item for item in keep_case_results}
    delivery_items = list(deliveries)
    single_delivery_execution_items = []
    combined_delivery_execution_items = []
    for index, delivery_entry in enumerate(delivery_items):
        delivery_case_results = [
            keep_case_results_by_case_id[case_id]
            for case_id in delivery_entry["case_ids"]
            if case_id in keep_case_results_by_case_id
        ]
        delivery_request: dict[str, Any] = {
            "index": index,
            "delivery": delivery_entry,
            "case_ids": [item["case_id"] for item in delivery_case_results],
        }
        strategy = delivery_strategy(delivery_entry)
        if strategy == "combined":
            delivery_request["case_items"] = [
                combined_delivery_case_view(item) for item in delivery_case_results
            ]
            combined_delivery_execution_items.append(delivery_request)
        else:
            delivery_request["case_items"] = [
                single_delivery_case_view(item) for item in delivery_case_results
            ]
            single_delivery_execution_items.append(delivery_request)
    return {
        "run_artifacts_root_path": str(run_artifacts_root),
        "workspace_snapshot_tar_path": str(workspace_snapshot_tar_path),
        "max_concurrency": resolve_delivery_patch_max_concurrency(
            len(combined_delivery_execution_items)
        ),
        "deliveries": delivery_items,
        "keep_case_ids": [item["case_id"] for item in keep_case_results],
        "single_delivery_execution_items": single_delivery_execution_items,
        "combined_delivery_execution_items": combined_delivery_execution_items,
    }


def persist_delivery_execution_input(
    *,
    run_artifacts_root: Path,
    deliveries: Sequence[DeliveryEntry],
    keep_case_results: Sequence[DeliveryCaseInput],
) -> None:
    combined_delivery_count = sum(
        1 for item in deliveries if delivery_strategy(item) == "combined"
    )
    execution_payload = {
        "summary": {
            "delivery_count": len(deliveries),
            "case_result_count": len(keep_case_results),
            "keep_case_count": len(keep_case_results),
            "combined_delivery_count": combined_delivery_count,
        },
        "deliveries": deliveries,
        "cases": [
            {
                "case_id": item["case_id"],
                "disposition": item["disposition"],
                "reason": item.get("reason"),
            }
            for item in keep_case_results
        ],
    }
    persist_json(
        run_artifacts_root / "delivery-execution",
        "delivery-execution-input.json",
        execution_payload,
    )


__all__ = [
    "build_delivery_execution_input",
    "combined_delivery_case_view",
    "delivery_strategy",
    "persist_delivery_execution_input",
    "resolve_delivery_patch_max_concurrency",
    "single_delivery_case_view",
]
