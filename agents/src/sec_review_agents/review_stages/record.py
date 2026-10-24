from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from sec_review_agents.review_stages.types import (
    CvssOutcome,
    PatchCoverage,
    RegressionStatus,
    ResolutionNextStep,
    ValidationLevel,
    Verdict,
    literal_values,
)
from sec_review_agents.utils.payloads import mapping_payload
from sec_review_agents.workspace.file_changes import FileChange


class ReviewRecordAnalysis(BaseModel):
    verdict: Verdict | None = None
    overview: str | None = None
    narratives: list[dict[str, Any]] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")

    @field_validator("verdict", mode="before")
    @classmethod
    def known_verdict(cls, value: Any) -> Verdict | None:
        return value if value in literal_values(Verdict) else None

    @field_validator("overview", mode="before")
    @classmethod
    def string_overview(cls, value: Any) -> str | None:
        return value if isinstance(value, str) else None

    @field_validator("narratives", mode="before")
    @classmethod
    def dict_narratives(cls, value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        return [item for item in value if isinstance(item, dict)]


class ReviewRecordMitigation(BaseModel):
    # `file_changes` is authoritative. `patch_diff` is a derived review and
    # location artifact; it must not be used to reconstruct final file contents.
    overview: str | None = None
    file_changes: list[FileChange] = Field(default_factory=list)
    patch_diff: str | None = None

    model_config = ConfigDict(extra="ignore")

    @field_validator("overview", "patch_diff", mode="before")
    @classmethod
    def string_or_none(cls, value: Any) -> str | None:
        return value if isinstance(value, str) else None

    @field_validator("file_changes", mode="before")
    @classmethod
    def dict_file_changes(cls, value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        return [item for item in value if isinstance(item, dict)]


class ReviewRecordVerification(BaseModel):
    overview: str | None = None
    review_target_claim: str | None = None
    validation_level: ValidationLevel | None = None
    patch_coverage: PatchCoverage | None = None
    regression_status: RegressionStatus | None = None
    resolution_next_step: ResolutionNextStep | None = None
    patch_findings: list[str] = Field(default_factory=list)
    verification_findings: list[str] = Field(default_factory=list)
    residual_risks: list[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")

    @field_validator("overview", "review_target_claim", mode="before")
    @classmethod
    def string_or_none(cls, value: Any) -> str | None:
        return value if isinstance(value, str) else None

    @field_validator("validation_level", mode="before")
    @classmethod
    def known_validation_level(cls, value: Any) -> ValidationLevel | None:
        return value if value in literal_values(ValidationLevel) else None

    @field_validator("patch_coverage", mode="before")
    @classmethod
    def known_patch_coverage(cls, value: Any) -> PatchCoverage | None:
        return value if value in literal_values(PatchCoverage) else None

    @field_validator("regression_status", mode="before")
    @classmethod
    def known_regression_status(cls, value: Any) -> RegressionStatus | None:
        return value if value in literal_values(RegressionStatus) else None

    @field_validator("resolution_next_step", mode="before")
    @classmethod
    def known_resolution_next_step(cls, value: Any) -> ResolutionNextStep | None:
        return value if value in literal_values(ResolutionNextStep) else None

    @field_validator(
        "patch_findings",
        "verification_findings",
        "residual_risks",
        mode="before",
    )
    @classmethod
    def string_list(cls, value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        return [item for item in value if isinstance(item, str)]


class ReviewRecordCvss(BaseModel):
    outcome: CvssOutcome | None = None
    base_score: float | None = None
    severity: str | None = None
    vector: str | None = None
    overview: str | None = None
    not_scored_reason: str | None = None

    model_config = ConfigDict(extra="ignore")

    @field_validator("outcome", mode="before")
    @classmethod
    def known_outcome(cls, value: Any) -> CvssOutcome | None:
        return value if value in literal_values(CvssOutcome) else None

    @field_validator(
        "severity",
        "vector",
        "overview",
        "not_scored_reason",
        mode="before",
    )
    @classmethod
    def string_or_none(cls, value: Any) -> str | None:
        return value if isinstance(value, str) else None

    @field_validator("base_score", mode="before")
    @classmethod
    def number_or_none(cls, value: Any) -> float | None:
        if isinstance(value, int | float) and not isinstance(value, bool):
            return float(value)
        return None


def build_review_record(
    *,
    analysis_result: Mapping[str, Any] | None,
    mitigation_result: Mapping[str, Any] | None,
    verifier_result: Mapping[str, Any] | None,
    cvss_result: Mapping[str, Any] | None,
) -> dict[str, Any]:
    cvss = (
        ReviewRecordCvss.model_validate(mapping_payload(cvss_result)).model_dump(
            mode="json"
        )
        if isinstance(cvss_result, Mapping)
        else None
    )
    return {
        "analysis": ReviewRecordAnalysis.model_validate(
            mapping_payload(analysis_result)
        ).model_dump(mode="json"),
        "mitigation": ReviewRecordMitigation.model_validate(
            mapping_payload(mitigation_result)
        ).model_dump(mode="json"),
        "verification": ReviewRecordVerification.model_validate(
            mapping_payload(verifier_result)
        ).model_dump(mode="json"),
        "cvss": cvss,
    }


__all__ = [
    "ReviewRecordAnalysis",
    "ReviewRecordCvss",
    "ReviewRecordMitigation",
    "ReviewRecordVerification",
    "build_review_record",
]
