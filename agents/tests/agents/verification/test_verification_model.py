import pytest

from sec_review_agents.agents.verification.model import VerificationOutput


def test_patch_full_with_claim_is_valid() -> None:
    """Keep `not-run` regression checks delivery-neutral by current policy."""
    result = VerificationOutput.model_validate(
        {
            "overview": "Patch fully covers the reviewed claim.",
            "target_claim": "reviewed claim",
            "coverage": "full",
            "next_step": "none",
            "findings": [],
            "validation_level": "static",
            "regression": "not-run",
            "evidence": ["patch fully covers the reviewed claim"],
        }
    )

    assert result.coverage == "full"


def test_patch_full_with_unresolved_regression_requires_manual_review() -> None:
    """Preserve full security coverage while routing unresolved regression risk."""
    result = VerificationOutput.model_validate(
        {
            "overview": "Patch fully covers the reviewed claim.",
            "target_claim": "reviewed claim",
            "coverage": "full",
            "next_step": "manual-review",
            "findings": ["compatibility note"],
            "validation_level": "static",
            "regression": "unresolved",
            "evidence": ["note"],
        }
    )

    assert result.findings == ["compatibility note"]
    assert result.regression == "unresolved"
    assert result.next_step == "manual-review"


@pytest.mark.parametrize("regression", ["failed", "unresolved"])
def test_patch_full_rejects_none_for_blocking_regression(
    regression: str,
) -> None:
    """Prevent a delivery-blocking regression from being reported as complete."""
    with pytest.raises(ValueError, match="requires retry-ai or manual-review"):
        VerificationOutput.model_validate(
            {
                "overview": "Security coverage is full but delivery is blocked.",
                "target_claim": "reviewed claim",
                "coverage": "full",
                "next_step": "none",
                "findings": ["regression blocks delivery"],
                "validation_level": "static",
                "regression": regression,
                "evidence": ["note"],
            }
        )


def test_patch_full_can_retry_confirmed_regression() -> None:
    """Allow a bounded retry to repair a regression after security closure."""
    result = VerificationOutput.model_validate(
        {
            "overview": "Security coverage is full but a regression needs repair.",
            "target_claim": "reviewed claim",
            "coverage": "full",
            "next_step": "retry-ai",
            "findings": ["restore the supported API behavior"],
            "validation_level": "static",
            "regression": "failed",
            "evidence": ["security target is covered"],
        }
    )

    assert result.coverage == "full"
    assert result.next_step == "retry-ai"


def test_patch_full_cannot_retry_unresolved_regression() -> None:
    """Route an unproven regression outcome to human review instead of patch retry."""
    with pytest.raises(ValueError, match="requires next_step=manual-review"):
        VerificationOutput.model_validate(
            {
                "overview": "Security coverage is full but regression evidence is unclear.",
                "target_claim": "reviewed claim",
                "coverage": "full",
                "next_step": "retry-ai",
                "findings": ["regression outcome is unresolved"],
                "validation_level": "static",
                "regression": "unresolved",
                "evidence": ["security target is covered"],
            }
        )


def test_partial_patch_can_retry_with_unresolved_regression() -> None:
    """Allow a bounded security retry while preserving unresolved regression risk."""
    result = VerificationOutput.model_validate(
        {
            "overview": "A security gap remains and regression evidence is unclear.",
            "target_claim": "reviewed claim",
            "coverage": "partial",
            "next_step": "retry-ai",
            "findings": [
                "close the remaining security gap",
                "reassess the unresolved regression concern after retry",
            ],
            "validation_level": "static",
            "regression": "unresolved",
            "evidence": ["the current patch is incomplete"],
        }
    )

    assert result.coverage == "partial"
    assert result.regression == "unresolved"
    assert result.next_step == "retry-ai"


@pytest.mark.parametrize("findings", [[], [""], ["   "]])
def test_patch_full_with_blocking_regression_requires_patch_finding(
    findings: list[str],
) -> None:
    """Require actionable context whenever regression evidence blocks delivery."""
    with pytest.raises(ValueError, match="requires a concrete finding"):
        VerificationOutput.model_validate(
            {
                "overview": "Security coverage is full but delivery is blocked.",
                "target_claim": "reviewed claim",
                "coverage": "full",
                "next_step": "manual-review",
                "findings": findings,
                "validation_level": "static",
                "regression": "failed",
                "evidence": ["security target is covered"],
            }
        )


def test_full_without_a_concrete_concern_rejects_follow_up() -> None:
    """Require a concrete concern before requesting follow-up on safe code."""
    with pytest.raises(ValueError, match="requires a concrete finding"):
        VerificationOutput.model_validate(
            {
                "overview": "Patch fully covers the reviewed claim.",
                "target_claim": "reviewed claim",
                "coverage": "full",
                "next_step": "manual-review",
                "findings": [],
                "validation_level": "static",
                "regression": "passed",
                "evidence": ["note"],
            }
        )


def test_retry_ai_requires_findings() -> None:
    result = VerificationOutput.model_validate(
        {
            "overview": "Patch partially covers the reviewed claim.",
            "target_claim": "reviewed claim",
            "coverage": "partial",
            "next_step": "retry-ai",
            "findings": ["fix the remaining bypass"],
            "validation_level": "static",
            "regression": "not-run",
            "evidence": ["note"],
        }
    )

    assert result.next_step == "retry-ai"


@pytest.mark.parametrize("findings", [[], [""], ["   "]])
def test_retry_ai_rejects_blank_findings(
    findings: list[str],
) -> None:
    """Reject retry feedback that contains no actionable finding text."""
    with pytest.raises(ValueError, match="requires at least one concrete finding"):
        VerificationOutput.model_validate(
            {
                "overview": "Patch partially covers the reviewed claim.",
                "target_claim": "reviewed claim",
                "coverage": "partial",
                "next_step": "retry-ai",
                "findings": findings,
                "validation_level": "static",
                "regression": "not-run",
                "evidence": ["note"],
            }
        )


def test_already_safe_baseline_can_have_no_next_step() -> None:
    result = VerificationOutput.model_validate(
        {
            "overview": "Repository evidence shows the baseline already blocks the reported path.",
            "target_claim": "reviewed claim",
            "coverage": "full",
            "next_step": "none",
            "findings": [],
            "validation_level": "static",
            "regression": "not-applicable",
            "evidence": [
                "Repository evidence shows the baseline already blocks the reported path."
            ],
        }
    )

    assert result.coverage == "full"
    assert result.next_step == "none"


def test_partial_patch_cannot_have_no_next_step() -> None:
    with pytest.raises(ValueError):
        VerificationOutput.model_validate(
            {
                "overview": "Patch partially covers the reviewed claim.",
                "target_claim": "reviewed claim",
                "coverage": "partial",
                "next_step": "none",
                "findings": ["fix the remaining bypass"],
                "validation_level": "static",
                "regression": "not-run",
                "evidence": ["note"],
            }
        )


def test_manual_review_partial_does_not_require_findings() -> None:
    result = VerificationOutput.model_validate(
        {
            "overview": "Patch partially covers the reviewed claim.",
            "target_claim": "reviewed claim",
            "coverage": "partial",
            "next_step": "manual-review",
            "findings": ["history cleanup"],
            "validation_level": "static",
            "regression": "not-run",
            "evidence": ["note"],
        }
    )

    assert result.next_step == "manual-review"


def test_safe_baseline_does_not_approve_unnecessary_changes() -> None:
    """Security closure is separate from accepting a supplied patch for delivery."""
    result = VerificationOutput(
        overview="Baseline is safe but the supplied metadata change is unrelated.",
        target_claim="The baseline must block unsafe extraction.",
        coverage="full",
        next_step="retry-ai",
        findings=["Remove the unrelated version bump."],
        evidence=["The baseline already rejects the reported input."],
        validation_level="static",
        regression="not-run",
    )
    assert result.coverage == "full"
    assert result.next_step == "retry-ai"


def test_unmodified_code_with_concrete_gap_can_request_repair() -> None:
    result = VerificationOutput(
        overview="The unchanged baseline still has a concrete gap.",
        target_claim="Reject unsafe extraction paths.",
        coverage="partial",
        next_step="retry-ai",
        findings=["Validate the path before extraction."],
        evidence=["The baseline does not guard this path."],
        validation_level="static",
        regression="not-applicable",
    )
    assert result.next_step == "retry-ai"
