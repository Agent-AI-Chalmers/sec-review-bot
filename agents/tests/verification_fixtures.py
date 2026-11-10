from sec_review_agents.review_stages.verification.result import (
    VerificationStageResult,
)


def skipped_verification_fixture(*, reason: str) -> VerificationStageResult:
    """Provide the skipped-verifier shape: unset assessments and no retry."""
    return VerificationStageResult(
        overview=reason,
        target_claim=None,
        coverage=None,
        next_step="none",
        findings=[],
        evidence=[],
        validation_level=None,
        regression=None,
        residual_risks=[],
    )
