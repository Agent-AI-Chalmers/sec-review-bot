from collections.abc import Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from sec_review_agents.contract_versions import EXECUTION_API_VERSION
from sec_review_agents.delivery_stages.result import DeliveryArtifact, DeliveryResult
from sec_review_agents.workflows.repository.scan_result import RepositoryScanResult
from sec_review_agents.workflows.repository_case.result import RepositoryCaseResult


class ScanSummary(BaseModel):
    scannable_file_count: int = 0
    scanned_file_count: int = 0
    skipped_file_count: int = 0
    candidate_count: int = 0
    case_count: int = 0
    suppressed_candidate_count: int = 0
    # Files the window removed. Reported here because it explains why an incremental run found
    # little: deletions never reach discovery, which has no current content to read for them.
    deleted_file_count: int = 0

    model_config = ConfigDict(extra="ignore")

    @field_validator("*", mode="before")
    @classmethod
    def count_value(cls, value: Any) -> int:
        return value if isinstance(value, int) and not isinstance(value, bool) else 0


class RepositoryWorkflowResult(BaseModel):
    api_version: str = EXECUTION_API_VERSION
    scan_summary: ScanSummary
    deliveries: list[DeliveryArtifact] = Field(default_factory=list)
    case_results: list[RepositoryCaseResult] = Field(default_factory=list)
    # A window with more deletions than review covers skips deletion review for all of them. The
    # count is in scan_summary; this says whether it was acted on, so a run whose deletions went
    # unreviewed cannot read as an ordinary success.
    deletion_review_skipped: bool = False

    model_config = ConfigDict(extra="ignore")


def build_scan_summary(
    *,
    scan_result: RepositoryScanResult | None,
) -> ScanSummary:
    """Project the scan stage results into the published summary.

    Everything counted here is something the scan observed about the window, so it is read from
    the scan result rather than passed alongside it.
    """
    if scan_result is None:
        return ScanSummary()
    discovery_counts = scan_result.discovery_result.counts
    triage_counts = scan_result.triage_result.counts
    return ScanSummary(
        scannable_file_count=discovery_counts.scannable_file_count,
        scanned_file_count=discovery_counts.scanned_file_count,
        skipped_file_count=discovery_counts.skipped_file_count,
        candidate_count=discovery_counts.candidate_count,
        case_count=triage_counts.case_count,
        suppressed_candidate_count=triage_counts.suppressed_candidate_count,
        deleted_file_count=scan_result.deleted_file_count,
    )


def build_repository_workflow_result(
    *,
    scan_result: RepositoryScanResult | None,
    delivery_result: DeliveryResult | None,
    case_results: Sequence[RepositoryCaseResult],
) -> dict[str, Any]:
    """Assemble the published result from the run's stage outputs.

    Every input is a stage output, so nothing about the window arrives here as a loose argument
    that the stages never produced.
    """
    # The window's deletion reading is produced by the scan but published in two places, and each
    # placement is deliberate. The count belongs in scan_summary with the other counts. The skip
    # flag cannot join it there: scan_summary is counts only, and a boolean would break that
    # shape. It is published at the top level instead, where a consumer reading only the summary
    # numbers cannot mistake an unreviewed window for a reviewed one.
    return RepositoryWorkflowResult.model_validate(
        {
            "api_version": EXECUTION_API_VERSION,
            "scan_summary": build_scan_summary(scan_result=scan_result),
            "deliveries": (
                delivery_result.deliveries if delivery_result is not None else []
            ),
            "case_results": case_results,
            "deletion_review_skipped": (
                scan_result.deletion_review_skipped
                if scan_result is not None
                else False
            ),
        }
    ).model_dump(mode="json")
