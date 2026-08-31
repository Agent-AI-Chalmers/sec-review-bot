"""Delivery planning payloads kept workflow-orchestration neutral."""

from typing import Any, Literal, TypedDict

from sec_review_agents.review_stages.types import PatchCoverage
from sec_review_agents.workspace.file_changes import FileChange

# Domain types

DeliveryStrategy = Literal["single", "combined"]


# Delivery plan payload


class DeliveryEntry(TypedDict):
    delivery_id: str
    strategy: DeliveryStrategy
    case_ids: list[str]
    reason: str


class DeliveryPlan(TypedDict):
    status: str
    metadata: dict[str, Any]
    counts: dict[str, int]
    deliveries: list[DeliveryEntry]


class DeliveryCaseInput(TypedDict):
    """Case data projected by repository workflow for delivery stages."""

    case_id: str
    disposition: str
    reason: str | None
    analyzer_overview: str
    analyzer_verdict: str | None
    mitigation_overview: str
    mitigator_changed_files: list[str]
    mitigator_file_changes: list[FileChange]
    mitigator_patch_diff: str | None
    verifier_overview: str
    verifier_coverage: PatchCoverage | None
    verifier_patch_findings: list[str]
    verifier_findings: list[str]
    residual_risks: list[str]
