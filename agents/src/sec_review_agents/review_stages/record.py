from pydantic import BaseModel, ConfigDict, Field

from sec_review_agents.agents.analysis.model import Narrative
from sec_review_agents.review_stages.analysis.result import AnalysisStageResult
from sec_review_agents.review_stages.cvss.result import CvssStageResult
from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from sec_review_agents.review_stages.types import (
    CvssOutcome,
    PatchCoverage,
    RegressionStatus,
    ResolutionNextStep,
    ValidationLevel,
    Verdict,
)
from sec_review_agents.review_stages.verification.result import VerificationStageResult
from sec_review_agents.workspace.file_changes import DeletedFileChange, UpsertFileChange


class ReviewRecordAnalysis(BaseModel):
    verdict: Verdict | None = None
    overview: str | None = None
    narratives: list[Narrative] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore", strict=True)


class ReviewRecordMitigation(BaseModel):
    # `file_changes` is authoritative. `patch_diff` is a derived review and
    # location artifact; it must not be used to reconstruct final file contents.
    overview: str | None = None
    file_changes: list[DeletedFileChange | UpsertFileChange] = Field(
        default_factory=list
    )
    patch_diff: str | None = None

    model_config = ConfigDict(extra="ignore", strict=True)


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

    model_config = ConfigDict(extra="ignore", strict=True)


class ReviewRecordCvss(BaseModel):
    outcome: CvssOutcome | None = None
    base_score: float | None = None
    severity: str | None = None
    vector: str | None = None
    overview: str | None = None
    not_scored_reason: str | None = None

    model_config = ConfigDict(extra="ignore", strict=True)


class ReviewRecord(BaseModel):
    """Common published review sections, independent of workflow disposition.

    Absent stages produce empty sections, while absent scoring remains null.
    Workflow-specific strategies construct these sections from their own results;
    repository case identity and delivery decisions do not belong in this record.
    """

    analysis: ReviewRecordAnalysis = Field(default_factory=ReviewRecordAnalysis)
    mitigation: ReviewRecordMitigation = Field(default_factory=ReviewRecordMitigation)
    verification: ReviewRecordVerification = Field(
        default_factory=ReviewRecordVerification
    )
    cvss: ReviewRecordCvss | None = None


def build_review_record(
    *,
    analysis_result: AnalysisStageResult | None,
    mitigation_result: MitigationStageResult | None,
    verifier_result: VerificationStageResult | None,
    cvss_result: CvssStageResult | None,
) -> ReviewRecord:
    """Project validated stage outputs without an intermediate JSON round trip."""
    return ReviewRecord(
        analysis=(
            ReviewRecordAnalysis.model_validate(analysis_result, from_attributes=True)
            if analysis_result is not None
            else ReviewRecordAnalysis()
        ),
        mitigation=(
            ReviewRecordMitigation.model_validate(
                mitigation_result, from_attributes=True
            )
            if mitigation_result is not None
            else ReviewRecordMitigation()
        ),
        verification=(
            ReviewRecordVerification.model_validate(
                verifier_result, from_attributes=True
            )
            if verifier_result is not None
            else ReviewRecordVerification()
        ),
        cvss=(
            ReviewRecordCvss.model_validate(cvss_result, from_attributes=True)
            if cvss_result is not None
            else None
        ),
    )


__all__ = [
    "ReviewRecord",
    "ReviewRecordAnalysis",
    "ReviewRecordCvss",
    "ReviewRecordMitigation",
    "ReviewRecordVerification",
    "build_review_record",
]
