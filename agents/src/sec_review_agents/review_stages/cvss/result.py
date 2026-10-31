from pydantic import BaseModel, ConfigDict, Field

from sec_review_agents.review_stages.types import CvssOutcome

# Stage result payload


class CvssMetricDetail(BaseModel):
    value: str
    rationale: str

    model_config = ConfigDict(extra="ignore")


class CvssStageResult(BaseModel):
    """Scoring outcome carried through case execution before record publication.

    Skipped and unscored outcomes retain absent scoring fields as None. The optional
    reason is omitted from artifacts when absent; the public review record owns
    its own projection rather than consuming this artifact.
    """

    outcome: CvssOutcome
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
    outcome: CvssOutcome,
    overview: str,
    version: str | None = None,
    vector: str | None = None,
    base_score: float | None = None,
    severity: str | None = None,
    metrics: dict[str, CvssMetricDetail] | None = None,
    not_scored_reason: str | None = None,
) -> CvssStageResult:
    return CvssStageResult(
        outcome=outcome,
        overview=overview,
        version=version,
        vector=vector,
        base_score=base_score,
        severity=severity,
        metrics=metrics or {},
        not_scored_reason=not_scored_reason,
    )


def build_skipped_cvss_v4_result(*, reason: str) -> CvssStageResult:
    return build_cvss_v4_stage_result(outcome="skipped", overview=reason)


# Public exports

__all__ = [
    "CvssMetricDetail",
    "CvssStageResult",
    "build_cvss_v4_stage_result",
    "build_skipped_cvss_v4_result",
]
