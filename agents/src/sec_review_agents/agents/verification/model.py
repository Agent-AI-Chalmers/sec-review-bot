from pydantic import BaseModel, Field, model_validator

from sec_review_agents.review_stages.types import (
    PatchCoverage,
    RegressionStatus,
    ResolutionNextStep,
    ValidationLevel,
)

# Agent structured output


class VerificationOutput(BaseModel):
    """
    Keep `overview`, `review_target_claim`, `patch_coverage`, `regression_status`, and `resolution_next_step` mutually consistent.
    Treat `overview` as orientation, not as a compressed replacement for the full verification findings.
    Keep `review_target_claim` as the strongest repository-grounded claim actually reviewed, and keep
    `patch_coverage` scoped to that same claim. Assess `regression_status` independently.
    Use `patch_coverage=full` only when the target claim is explicit and the checked evidence supports that strong judgment.
    Keep `patch_findings` and `verification_findings` semantically distinct: patch findings capture security-target
    gaps and delivery-blocking regressions, while verification findings capture the verifier's core checked observations.
    Keep `residual_risks` for remaining exposure or uncertainty that still matters after the main verification judgment.
    `resolution_next_step` expresses the overall action after considering coverage and regression status;
    `validate_result` enforces valid combinations.
    """

    overview: str = Field(
        description=(
            "Compact top-line summary of the verification judgment. "
            "Keep it consistent with the structured outcome fields. "
            "Use it as brief orientation for downstream stages rather than as a replacement for "
            "patch_findings or verification_findings."
        ),
    )
    review_target_claim: str = Field(
        description="The strongest repository-grounded claim the verifier treated as the target of patch review.",
    )
    patch_coverage: PatchCoverage = Field(
        description=(
            "How fully the patch covers review_target_claim, assessed independently "
            "from regression_status. "
            "Use `full` when the patch covers the target claim across relevant reachable behaviors; "
            "`partial` when it addresses the claim incompletely or as narrow hardening; "
            "`local-only` when it fixes a real local bug but does not cover the target claim; "
            "`misaligned` when the patch addresses a different primary problem than the verified claim; "
            "`unresolved` when available evidence does not support a reliable closure on patch coverage; "
            "`no-patch` when no patch was applied or available to review; "
            "and `not-applicable` only when patch review genuinely does not apply."
        ),
    )
    resolution_next_step: ResolutionNextStep = Field(
        description=(
            "What should happen next after considering patch_coverage and regression_status. "
            "Use `none` when no further action is needed; `retry-ai` when a concrete "
            "problem is likely fixable by another bounded AI mitigation pass; and "
            "`manual-review` when the remaining work requires human or external action."
        ),
    )
    patch_findings: list[str] = Field(
        default_factory=list,
        description=(
            "Concrete patch problems requiring follow-up, including security coverage "
            "gaps and delivery-blocking regressions."
        ),
    )
    verification_findings: list[str] = Field(
        default_factory=list,
        description="Core verification observations aligned with the strongest repository or runtime evidence the verifier personally checked.",
    )
    validation_level: ValidationLevel = Field(
        description=(
            "How directly the verifier validated the patch judgment beyond repository reading. "
            "Use `static` for code-only patch review, `logic-simulated` for focused in-process experiments such as "
            "a small `node -e` or `python -c` reproduction that does not exercise the real endpoint, "
            "`runtime-partial` for real execution that reaches only part of the intended flow, and "
            "`runtime-endpoint` only when the actual service or endpoint behavior was exercised end-to-end."
        ),
    )
    regression_status: RegressionStatus = Field(
        description=(
            "What regression, behavior-preservation, build, or test evidence shows, "
            "assessed independently from patch_coverage. "
            "Use `passed` when relevant checks were run and passed; `failed` when a relevant check failed or repository "
            "evidence shows the patch would break an existing checked contract; `not-run` when no regression/build/test "
            "check was run; `not-applicable` when no patch or regression check applies; and `unresolved` when attempted "
            "checks or available evidence do not support a reliable pass/fail judgment."
        ),
    )
    residual_risks: list[str] = Field(
        default_factory=list,
        description="Semantically distinct remaining exposure or uncertainty that still matters after the main verification judgment.",
    )

    @model_validator(mode="after")
    def validate_result(self) -> VerificationOutput:
        if not self.overview.strip():
            raise ValueError("overview is required.")
        strong_patch = self.patch_coverage == "full"
        if self.patch_coverage == "not-applicable" and not self.verification_findings:
            raise ValueError(
                "at least one verification note is required when patch assessment is not-applicable."
            )
        if strong_patch and not self.review_target_claim.strip():
            raise ValueError(
                "review_target_claim is required for patch_coverage=full judgments."
            )
        blocking_regression = self.regression_status in {"failed", "unresolved"}
        # Coverage describes the security target only. A full security repair can
        # still require follow-up when regression evidence blocks safe delivery.
        if strong_patch and blocking_regression and self.resolution_next_step == "none":
            raise ValueError(
                "patch_coverage=full with failed or unresolved regression evidence "
                "requires retry-ai or manual-review."
            )
        if strong_patch and blocking_regression and not self.patch_findings:
            raise ValueError(
                "patch_coverage=full with failed or unresolved regression evidence "
                "requires a concrete patch finding."
            )
        if (
            strong_patch
            and self.regression_status == "unresolved"
            and self.resolution_next_step != "manual-review"
        ):
            raise ValueError(
                "patch_coverage=full with unresolved regression evidence requires "
                "resolution_next_step=manual-review."
            )
        if (
            strong_patch
            and not blocking_regression
            and self.resolution_next_step != "none"
        ):
            raise ValueError(
                "patch_coverage=full without a blocking regression requires "
                "resolution_next_step=none."
            )
        if (
            not strong_patch
            and self.patch_coverage not in {"not-applicable", "no-patch"}
            and self.resolution_next_step == "none"
        ):
            raise ValueError(
                "resolution_next_step=none is only valid for full, no-patch, or not-applicable patch judgments."
            )
        if self.resolution_next_step == "retry-ai" and not self.patch_findings:
            raise ValueError(
                "resolution_next_step=retry-ai requires at least one patch finding."
            )
        if (
            self.resolution_next_step == "retry-ai"
            and self.patch_coverage == "not-applicable"
        ):
            raise ValueError(
                "resolution_next_step=retry-ai requires retry-eligible patch coverage."
            )

        return self
