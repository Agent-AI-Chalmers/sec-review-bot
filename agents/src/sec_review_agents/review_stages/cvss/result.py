from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# Stage result payload


class CvssMetricDetail(BaseModel):
    value: str
    rationale: str

    model_config = ConfigDict(extra="ignore")


class CvssStageResult(BaseModel):
    outcome: str
    overview: str
    version: str | None
    vector: str | None
    base_score: float | None
    severity: str | None
    metrics: dict[str, CvssMetricDetail] = Field(default_factory=dict)
    not_scored_reason: str | None = None

    model_config = ConfigDict(extra="ignore")


def build_cvss_v4_stage_result(
    *,
    outcome: Literal["scored", "not-scored", "skipped"],
    overview: str,
    version: str | None = None,
    vector: str | None = None,
    base_score: float | None = None,
    severity: str | None = None,
    metrics: dict[str, dict[str, str]] | None = None,
    not_scored_reason: str | None = None,
) -> dict[str, Any]:
    result = CvssStageResult.model_validate(
        {
            "outcome": outcome,
            "overview": overview,
            "version": version,
            "vector": vector,
            "base_score": base_score,
            "severity": severity,
            "metrics": metrics or {},
            "not_scored_reason": not_scored_reason,
        }
    ).model_dump(mode="json")
    if not_scored_reason is None:
        result.pop("not_scored_reason", None)
    return result


def build_skipped_cvss_v4_result(*, reason: str) -> dict[str, Any]:
    return build_cvss_v4_stage_result(outcome="skipped", overview=reason)


def build_failed_cvss_v4_result(*, error: str) -> dict[str, Any]:
    return {
        "overview": f"CVSS v4.0 scoring failed: {error}",
        "error": error,
    }


# Public exports

__all__ = [
    "CvssMetricDetail",
    "CvssStageResult",
    "build_cvss_v4_stage_result",
    "build_failed_cvss_v4_result",
    "build_skipped_cvss_v4_result",
]
