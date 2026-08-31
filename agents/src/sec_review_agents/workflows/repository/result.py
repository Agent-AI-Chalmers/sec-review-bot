from collections.abc import Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from sec_review_agents.review_stages.record import build_review_record
from sec_review_agents.utils.payloads import mapping_payload


class RepositoryCaseResult(BaseModel):
    case_id: str | None = None
    disposition: str | None = None
    reason: str | None = None
    review_record: dict[str, Any] | None = None

    model_config = ConfigDict(extra="ignore")

    @field_validator("case_id", "disposition", "reason", mode="before")
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

    model_config = ConfigDict(extra="ignore")

    @field_validator("*", mode="before")
    @classmethod
    def count_value(cls, value: Any) -> int:
        return value if isinstance(value, int) and not isinstance(value, bool) else 0


class RepositoryWorkflowResult(BaseModel):
    contract_version: str = "v4"
    scan_summary: ScanSummary
    deliveries: list[dict[str, Any]] = Field(default_factory=list)
    case_results: list[RepositoryCaseResult] = Field(default_factory=list)

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


def _repository_review_record(review_record: Any) -> dict[str, Any] | None:
    if not isinstance(review_record, Mapping):
        return None
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
        result = model.model_dump(mode="json")
        if review_record is None:
            result.pop("review_record", None)
        results.append(result)
    return results


def build_scan_summary(
    *,
    discovery_result: Mapping[str, Any] | None,
    triage_result: Mapping[str, Any] | None,
) -> dict[str, Any]:
    discovery_counts = mapping_payload(mapping_payload(discovery_result).get("counts"))
    triage_counts = mapping_payload(mapping_payload(triage_result).get("counts"))
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
        }
    ).model_dump(mode="json")


def build_repository_workflow_result(
    *,
    discovery_result: Mapping[str, Any] | None,
    triage_result: Mapping[str, Any] | None,
    delivery_result: Mapping[str, Any] | None,
    case_results: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    repository_case_results = _repository_case_results(case_results)
    repository_scan_summary = build_scan_summary(
        discovery_result=discovery_result,
        triage_result=triage_result,
    )
    return RepositoryWorkflowResult.model_validate(
        {
            "contract_version": "v4",
            "scan_summary": repository_scan_summary,
            "deliveries": _repository_deliveries(delivery_result),
            "case_results": repository_case_results,
        }
    ).model_dump(mode="json")
