from pydantic import BaseModel, Field, model_validator

from sec_review_agents.review_stages.types import (
    CoverageStatus,
    NextStep,
    RegressionStatus,
    ValidationLevel,
)
from sec_review_agents.utils.pydantic_types import NonEmptyText

# Agent structured output


class VerificationOutput(BaseModel):
    """
    Keep `overview`, `target_claim`, `coverage`, `regression`, and `next_step` mutually consistent.
    Treat `overview` as orientation, not as a compressed replacement for the full verification findings.
    Keep `target_claim` as the scoped claim actually checked against repository evidence, and keep
    `coverage` scoped to that same claim, with or without a patch. Assess `regression` independently.
    Use `coverage=full` only when the target claim is explicit and the checked evidence supports that strong judgment.
    Keep `findings` and `evidence` distinct: findings describe concrete problems requiring
    follow-up; evidence records the checks and observations supporting the judgment.
    Keep `residual_risks` for remaining exposure or uncertainty that still matters after the main verification judgment.
    `next_step` expresses the overall action after considering coverage and regression status;
    `validate_result` enforces valid combinations.
    """

    overview: NonEmptyText = Field(
        description=(
            "Compact top-line summary of the verification judgment. "
            "Keep it consistent with the structured outcome fields. "
            "Use it as brief orientation for downstream stages rather than as a replacement for "
            "findings or evidence."
        ),
    )
    target_claim: NonEmptyText = Field(
        description="The scoped security claim checked against current repository evidence.",
    )
    coverage: CoverageStatus = Field(
        description=(
            "How fully the current code resolves target_claim, assessed independently "
            "from regression. "
            "Use `full` when evidence shows the current code is safe for the scoped claim, including when the baseline is already fixed or the claim is disproved; "
            "`partial` when a concrete gap remains, including when no repair was made; "
            "`local-only` when protection holds only for a local subset of the target; "
            "`misaligned` when the mitigation addresses a different problem while the target remains open; "
            "`unresolved` when available evidence is insufficient to judge the current code. "
            "Assess the baseline if no changes were made; file_changes records patch presence separately."
        ),
    )
    next_step: NextStep = Field(
        description=(
            "What should happen next after considering coverage and regression. "
            "Use `none` when no further action is needed for the target or supplied changes; `retry-ai` when a concrete "
            "problem is likely fixable by another bounded AI mitigation pass; and "
            "`manual-review` when the remaining work requires human or external action."
        ),
    )
    findings: list[str] = Field(
        default_factory=list,
        description=(
            "Concrete problems requiring follow-up, including security coverage "
            "gaps and delivery-blocking regressions."
        ),
    )
    evidence: list[str] = Field(
        default_factory=list,
        description="Core verification observations aligned with the strongest repository or runtime evidence the verifier personally checked.",
    )
    validation_level: ValidationLevel = Field(
        description=(
            "How directly the verifier validated the current-code judgment beyond repository reading. "
            "Use `static` for code-only patch review, `logic-simulated` for focused in-process experiments such as "
            "a small `node -e` or `python -c` reproduction that does not exercise the real endpoint, "
            "`runtime-partial` for real execution that reaches only part of the intended flow, and "
            "`runtime-endpoint` only when the actual service or endpoint behavior was exercised end-to-end."
        ),
    )
    regression: RegressionStatus = Field(
        description=(
            "What regression, behavior-preservation, build, or test evidence shows, "
            "assessed independently from coverage. "
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
        fully_resolved = self.coverage == "full"
        has_concrete_finding = any(finding.strip() for finding in self.findings)
        if fully_resolved and not self.target_claim.strip():
            raise ValueError("target_claim is required for coverage=full judgments.")
        blocking_regression = self.regression in {"failed", "unresolved"}
        # Coverage concerns current-code safety, not patch presence or approval.
        # Even a safe baseline can have supplied changes that need correction.
        if fully_resolved and blocking_regression and self.next_step == "none":
            raise ValueError(
                "coverage=full with failed or unresolved regression evidence "
                "requires retry-ai or manual-review."
            )
        if fully_resolved and blocking_regression and not has_concrete_finding:
            raise ValueError(
                "coverage=full with failed or unresolved regression evidence "
                "requires a concrete finding."
            )
        if (
            fully_resolved
            and self.regression == "unresolved"
            and self.next_step != "manual-review"
        ):
            raise ValueError(
                "coverage=full with unresolved regression evidence requires "
                "next_step=manual-review."
            )
        if not fully_resolved and self.next_step == "none":
            raise ValueError("next_step=none requires coverage=full.")
        if (
            fully_resolved
            and not blocking_regression
            and self.next_step != "none"
            and not has_concrete_finding
        ):
            raise ValueError(
                "Follow-up after coverage=full requires a concrete finding."
            )
        if self.next_step == "retry-ai" and not has_concrete_finding:
            raise ValueError(
                "next_step=retry-ai requires at least one concrete finding."
            )
        return self
