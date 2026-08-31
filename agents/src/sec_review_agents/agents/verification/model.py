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
    `patch_coverage` and `patch_findings` scoped to that same claim.
    Use `patch_coverage=full` only when the target claim is explicit and the checked evidence supports that strong judgment.
    Keep `patch_findings` and `verification_findings` semantically distinct: patch findings capture patch-level
    gaps, limitations, or concerns, while verification findings capture the verifier's core checked observations.
    Keep `residual_risks` for remaining exposure or uncertainty that still matters after the main verification judgment.
    """

    overview: str = Field(
        description=(
            "Compact top-line summary of the verification judgment. "
            "Keep it aligned with review_target_claim, patch_coverage, and resolution_next_step. "
            "Use it as brief orientation for downstream stages rather than as a replacement for "
            "patch_findings or verification_findings."
        ),
    )
    review_target_claim: str = Field(
        description="The strongest repository-grounded claim the verifier treated as the target of patch review.",
    )
    patch_coverage: PatchCoverage = Field(
        description=(
            "How fully the patch covers the verifier's target claim. "
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
            "What should happen next after this verification judgment. "
            "Use `none` when the patch is fully verified or no further action is needed; "
            "`retry-ai` when the remaining gap is concrete, in scope, and likely fixable by another bounded AI mitigation pass; "
            "and `manual-review` when the remaining work needs a human, administrator action, credential rotation, deployment change, history cleanup, product judgment, or other work outside a normal workspace patch."
        ),
    )
    patch_findings: list[str] = Field(
        default_factory=list,
        description=(
            "Patch-level gaps, limitations, or concerns grounded in checked evidence."
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
            "Whether focused regression, behavior-preservation, build, or test evidence supports the patched workspace. "
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
        if strong_patch and self.resolution_next_step != "none":
            raise ValueError("patch_coverage=full requires resolution_next_step=none.")
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
        if self.resolution_next_step == "retry-ai" and self.patch_coverage in {
            "full",
            "not-applicable",
        }:
            raise ValueError(
                "resolution_next_step=retry-ai requires retry-eligible patch coverage."
            )

        return self
