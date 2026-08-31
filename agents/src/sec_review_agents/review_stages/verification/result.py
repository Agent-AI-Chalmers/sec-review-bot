from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from sec_review_agents.review_stages.types import (
    PatchCoverage,
    RegressionStatus,
    ResolutionNextStep,
    ValidationLevel,
)

# Stage result payload


class VerificationStageResult(BaseModel):
    overview: str
    review_target_claim: str | None
    patch_coverage: PatchCoverage
    resolution_next_step: ResolutionNextStep
    patch_findings: list[str] = Field(default_factory=list)
    verification_findings: list[str] = Field(default_factory=list)
    validation_level: ValidationLevel
    regression_status: RegressionStatus
    residual_risks: list[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")


def build_verification_stage_result(
    *,
    overview: str,
    review_target_claim: str | None,
    patch_coverage: PatchCoverage,
    resolution_next_step: ResolutionNextStep,
    patch_findings: list,
    verification_findings: list,
    validation_level: ValidationLevel,
    regression_status: RegressionStatus,
    residual_risks: list,
) -> dict[str, Any]:
    return VerificationStageResult.model_validate(
        {
            "overview": overview,
            "review_target_claim": review_target_claim,
            "patch_coverage": patch_coverage,
            "resolution_next_step": resolution_next_step,
            "patch_findings": patch_findings,
            "verification_findings": verification_findings,
            "validation_level": validation_level,
            "regression_status": regression_status,
            "residual_risks": residual_risks,
        }
    ).model_dump(mode="json")
