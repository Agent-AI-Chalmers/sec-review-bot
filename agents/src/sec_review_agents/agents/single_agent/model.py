from pydantic import BaseModel, Field, model_validator

from sec_review_agents.review_stages.types import (
    RegressionStatus,
    ValidationLevel,
    Verdict,
)
from sec_review_agents.workspace.patches import normalize_declared_changed_files

# Agent structured output


class SingleAgentFixOutput(BaseModel):
    """
    Keep `overview`, `verdict`, `validation_level`, `regression_status`, `target_claim`, and `declared_changed_files`
    aligned to one final repository-grounded outcome after repair and self-check.
    Use `target_claim` for the strongest concrete claim the agent actually audited;
    leave it empty only when no actionable target was confirmed.
    Always use `self_check_notes` for concrete validation observations, and reserve
    `residual_risks` for remaining exposure or uncertainty after that self-check.
    """

    overview: str = Field(
        description="Compact repository-grounded summary of the final decision and any applied repair.",
        min_length=1,
    )
    verdict: Verdict = Field(
        description="Top-level repository-grounded outcome after the agent completed its inspection and self-check.",
    )
    validation_level: ValidationLevel = Field(
        description=(
            "How directly the final single-agent judgment was validated beyond repository reading. "
            "Use `static` for code-only analysis, `logic-simulated` for focused in-process experiments such as "
            "a small `node -e` or `python -c` reproduction that does not exercise the real endpoint, "
            "`runtime-partial` for real execution that reaches only part of the intended flow, and "
            "`runtime-endpoint` only when the actual service or endpoint behavior was exercised end-to-end."
        ),
    )
    regression_status: RegressionStatus = Field(
        description=(
            "Whether focused regression, behavior-preservation, build, or test evidence supports the repaired workspace. "
            "Use `passed` when relevant checks were run and passed; `failed` when a relevant check failed or repository "
            "evidence shows the patch would break an existing checked contract; `not-run` when no regression/build/test "
            "check was run; `not-applicable` when no patch or regression check applies; and `unresolved` when attempted "
            "checks or available evidence do not support a reliable pass/fail judgment."
        ),
    )
    target_claim: str = Field(
        description="The strongest concrete claim the agent treated as the review target; use empty string when no actionable issue was confirmed.",
    )
    declared_changed_files: list[str] = Field(
        default_factory=list,
        description=(
            "Repository-relative files intentionally changed by the repair and intended for patch export. "
            "Use paths like `src/app.py`; do not include `/workspace`, `workspace/`, `a/`, or `b/` prefixes."
        ),
    )
    residual_risks: list[str] = Field(
        default_factory=list,
        max_length=5,
        description="Residual risks or uncertainty that remain after the final self-check.",
    )
    self_check_notes: list[str] = Field(
        default_factory=list,
        max_length=5,
        description="Brief notes summarizing what the agent validated during its own critical self-check.",
    )

    @model_validator(mode="after")
    def validate_result(self) -> SingleAgentFixOutput:
        self.declared_changed_files = normalize_declared_changed_files(
            self.declared_changed_files
        )
        if not self.self_check_notes:
            raise ValueError("at least one self_check_note is required.")
        return self


# Public exports

__all__ = [
    "SingleAgentFixOutput",
]
