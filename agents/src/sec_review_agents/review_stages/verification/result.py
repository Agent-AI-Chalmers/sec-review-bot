from pydantic import BaseModel, ConfigDict, Field

from sec_review_agents.review_stages.types import (
    PatchCoverage,
    RegressionStatus,
    ResolutionNextStep,
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
    review_target_claim: str | None
    patch_coverage: PatchCoverage | None
    resolution_next_step: ResolutionNextStep
    patch_findings: list[str] = Field(default_factory=list)
    verification_findings: list[str] = Field(default_factory=list)
    validation_level: ValidationLevel | None
    regression_status: RegressionStatus | None
    residual_risks: list[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")


def build_verification_stage_result(
    *,
    overview: str,
    review_target_claim: str | None,
    patch_coverage: PatchCoverage,
    resolution_next_step: ResolutionNextStep,
    patch_findings: list[str],
    verification_findings: list[str],
    validation_level: ValidationLevel,
    regression_status: RegressionStatus,
    residual_risks: list[str],
) -> VerificationStageResult:
    """Build a completed assessment with required coverage and validation fields.

    The shared result also represents skipped stages, whose assessments may be
    absent. Keep the completed-call signature stricter than that storage shape.
    """
    return VerificationStageResult(
        overview=overview,
        review_target_claim=review_target_claim,
        patch_coverage=patch_coverage,
        resolution_next_step=resolution_next_step,
        patch_findings=patch_findings,
        verification_findings=verification_findings,
        validation_level=validation_level,
        regression_status=regression_status,
        residual_risks=residual_risks,
    )


def build_skipped_verification_result(*, reason: str) -> VerificationStageResult:
    return VerificationStageResult(
        overview=reason,
        review_target_claim=None,
        patch_coverage=None,
        resolution_next_step="none",
        patch_findings=[],
        verification_findings=[],
        validation_level=None,
        regression_status=None,
        residual_risks=[],
    )
