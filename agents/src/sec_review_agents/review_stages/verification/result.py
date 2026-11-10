from pydantic import BaseModel, ConfigDict, Field

from sec_review_agents.review_stages.types import (
    CoverageStatus,
    NextStep,
    RegressionStatus,
    ValidationLevel,
)


class VerificationStageResult(BaseModel):
    """Verifier decision and findings carried between review activities.

    A skipped stage leaves coverage and validation assessments unset and requests
    no retry. Completed assessments retain their enum values for retry and
    delivery decisions; downstream code must not reinterpret absent assessments
    as approval. Artifact and public-record projection happen at their exits.
    """

    overview: str
    target_claim: str | None
    coverage: CoverageStatus | None
    next_step: NextStep
    findings: list[str] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)
    validation_level: ValidationLevel | None
    regression: RegressionStatus | None
    residual_risks: list[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")


def build_verification_stage_result(
    *,
    overview: str,
    target_claim: str | None,
    coverage: CoverageStatus,
    next_step: NextStep,
    findings: list[str],
    evidence: list[str],
    validation_level: ValidationLevel,
    regression: RegressionStatus,
    residual_risks: list[str],
) -> VerificationStageResult:
    """Build a completed assessment with required coverage and validation fields.

    The shared result also represents skipped stages, whose assessments may be
    absent. Keep the completed-call signature stricter than that storage shape.
    """
    return VerificationStageResult(
        overview=overview,
        target_claim=target_claim,
        coverage=coverage,
        next_step=next_step,
        findings=findings,
        evidence=evidence,
        validation_level=validation_level,
        regression=regression,
        residual_risks=residual_risks,
    )
