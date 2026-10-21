from collections.abc import Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from sec_review_agents.entrypoints.contract_schema import CONTRACT_VERSION
from sec_review_agents.review_stages.record import build_review_record
from sec_review_agents.utils.payloads import mapping_payload


class RepositoryCaseResult(BaseModel):
    # The published repository result requires a non-empty `case_id`, a non-empty
    # `disposition`, and a `review_record`. Keeping them optional here would serialize
    # `null` into that result and make the integration parser reject the whole run, so
    # fail at the builder instead.
    case_id: str
    disposition: str
    reason: str | None = None
    review_record: dict[str, Any]

    model_config = ConfigDict(extra="ignore")

    @field_validator("case_id", "disposition", mode="before")
    @classmethod
    def required_stripped_string(cls, value: Any) -> str:
        if isinstance(value, str) and value.strip():
            return value.strip()
        raise ValueError("a repository case result requires a non-empty value")

    @field_validator("reason", mode="before")
    @classmethod
    def stripped_string_or_none(cls, value: Any) -> str | None:
        return value.strip() if isinstance(value, str) and value.strip() else None


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
    contract_version: str = CONTRACT_VERSION
    scan_summary: ScanSummary
    deliveries: list[dict[str, Any]] = Field(default_factory=list)
    case_results: list[RepositoryCaseResult] = Field(default_factory=list)
    # A window with more deletions than review covers skips deletion review for all of them. The
    # count is in scan_summary; this says whether it was acted on, so a run whose deletions went
    # unreviewed cannot read as an ordinary success.
    deletion_review_skipped: bool = False

    model_config = ConfigDict(extra="ignore")


def _repository_deliveries(
    delivery_result: Mapping[str, Any] | None,
) -> list[dict[str, Any]]:
    if not isinstance(delivery_result, Mapping):
        return []
    return [
        item
        for item in (delivery_result.get("deliveries") or [])
        if isinstance(item, dict)
    ]


def _repository_review_record(review_record: Any) -> dict[str, Any]:
    if not isinstance(review_record, Mapping):
        return build_review_record(
            analysis_result=None,
            mitigation_result=None,
            verifier_result=None,
            cvss_result=None,
        )
    return build_review_record(
        analysis_result=mapping_payload(review_record.get("analysis")),
        mitigation_result=mapping_payload(review_record.get("mitigation")),
        verifier_result=mapping_payload(review_record.get("verification")),
        cvss_result=(
            mapping_payload(review_record.get("cvss"))
            if isinstance(review_record.get("cvss"), Mapping)
            else None
        ),
    )


def _repository_case_results(
    case_results: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for item in case_results:
        payload = mapping_payload(item)
        review_record = _repository_review_record(payload.get("review_record"))
        model = RepositoryCaseResult.model_validate(
            {
                "case_id": payload.get("case_id"),
                "disposition": payload.get("disposition"),
                "reason": payload.get("reason"),
                "review_record": review_record,
            }
        )
        results.append(model.model_dump(mode="json"))
    return results


def build_scan_summary(
    *,
    scan_result: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Project the scan stage results into the published summary.

    Everything counted here is something the scan observed about the window, so it is read from
    the scan result rather than passed alongside it.
    """
    scan = mapping_payload(scan_result)
    discovery_counts = mapping_payload(
        mapping_payload(scan.get("discovery_result")).get("counts")
    )
    triage_counts = mapping_payload(
        mapping_payload(scan.get("triage_result")).get("counts")
    )
    return ScanSummary.model_validate(
        {
            "scannable_file_count": discovery_counts.get("scannable_file_count"),
            "scanned_file_count": discovery_counts.get("scanned_file_count"),
            "skipped_file_count": discovery_counts.get("skipped_file_count"),
            "candidate_count": discovery_counts.get("candidate_count"),
            "case_count": triage_counts.get("case_count"),
            "suppressed_candidate_count": triage_counts.get(
                "suppressed_candidate_count"
            ),
            "deleted_file_count": scan.get("deleted_file_count"),
        }
    ).model_dump(mode="json")


def build_repository_workflow_result(
    *,
    scan_result: Mapping[str, Any] | None,
    delivery_result: Mapping[str, Any] | None,
    case_results: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Assemble the published result from the run's stage outputs.

    Every input is a stage output, so nothing about the window arrives here as a loose argument
    that the stages never produced.
    """
    scan = mapping_payload(scan_result)
    # The window's deletion reading is produced by the scan but published in two places, and each
    # placement is deliberate. The count belongs in scan_summary with the other counts. The skip
    # flag cannot join it there: scan_summary is counts only, and a boolean would break that
    # shape. It is published at the top level instead, where a consumer reading only the summary
    # numbers cannot mistake an unreviewed window for a reviewed one.
    return RepositoryWorkflowResult.model_validate(
        {
            "contract_version": CONTRACT_VERSION,
            "scan_summary": build_scan_summary(scan_result=scan_result),
            "deliveries": _repository_deliveries(delivery_result),
            "case_results": _repository_case_results(case_results),
            "deletion_review_skipped": bool(scan.get("deletion_review_skipped")),
        }
    ).model_dump(mode="json")
