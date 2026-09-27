import pytest

from sec_review_agents.agents.verification.model import VerificationOutput


def test_patch_full_with_claim_is_valid() -> None:
    result = VerificationOutput.model_validate(
        {
            "overview": "Patch fully covers the reviewed claim.",
            "review_target_claim": "reviewed claim",
            "patch_coverage": "full",
            "resolution_next_step": "none",
            "patch_findings": [],
            "validation_level": "static",
            "regression_status": "not-run",
            "verification_findings": ["patch fully covers the reviewed claim"],
        }
    )

    assert result.patch_coverage == "full"


def test_patch_full_with_unresolved_regression_requires_manual_review() -> None:
    """Preserve full security coverage while routing unresolved regression risk."""
    result = VerificationOutput.model_validate(
        {
            "overview": "Patch fully covers the reviewed claim.",
            "review_target_claim": "reviewed claim",
            "patch_coverage": "full",
            "resolution_next_step": "manual-review",
            "patch_findings": ["compatibility note"],
            "validation_level": "static",
            "regression_status": "unresolved",
            "verification_findings": ["note"],
        }
    )

    assert result.patch_findings == ["compatibility note"]
    assert result.regression_status == "unresolved"
    assert result.resolution_next_step == "manual-review"


@pytest.mark.parametrize("regression_status", ["failed", "unresolved"])
def test_patch_full_rejects_none_for_blocking_regression(
    regression_status: str,
) -> None:
    """Prevent a delivery-blocking regression from being reported as complete."""
    with pytest.raises(ValueError, match="requires retry-ai or manual-review"):
        VerificationOutput.model_validate(
            {
                "overview": "Security coverage is full but delivery is blocked.",
                "review_target_claim": "reviewed claim",
                "patch_coverage": "full",
                "resolution_next_step": "none",
                "patch_findings": ["regression blocks delivery"],
                "validation_level": "static",
                "regression_status": regression_status,
                "verification_findings": ["note"],
            }
        )


def test_patch_full_can_retry_confirmed_regression() -> None:
    """Allow a bounded retry to repair a regression after security closure."""
    result = VerificationOutput.model_validate(
        {
            "overview": "Security coverage is full but a regression needs repair.",
            "review_target_claim": "reviewed claim",
            "patch_coverage": "full",
            "resolution_next_step": "retry-ai",
            "patch_findings": ["restore the supported API behavior"],
            "validation_level": "static",
            "regression_status": "failed",
            "verification_findings": ["security target is covered"],
        }
    )

    assert result.patch_coverage == "full"
    assert result.resolution_next_step == "retry-ai"


def test_patch_full_cannot_retry_unresolved_regression() -> None:
    """Route an unproven regression outcome to human review instead of patch retry."""
    with pytest.raises(ValueError, match="requires resolution_next_step=manual-review"):
        VerificationOutput.model_validate(
            {
                "overview": "Security coverage is full but regression evidence is unclear.",
                "review_target_claim": "reviewed claim",
                "patch_coverage": "full",
                "resolution_next_step": "retry-ai",
                "patch_findings": ["regression outcome is unresolved"],
                "validation_level": "static",
                "regression_status": "unresolved",
                "verification_findings": ["security target is covered"],
            }
        )


def test_partial_patch_can_retry_with_unresolved_regression() -> None:
    """Allow a bounded security retry while preserving unresolved regression risk."""
    result = VerificationOutput.model_validate(
        {
            "overview": "A security gap remains and regression evidence is unclear.",
            "review_target_claim": "reviewed claim",
            "patch_coverage": "partial",
            "resolution_next_step": "retry-ai",
            "patch_findings": [
                "close the remaining security gap",
                "reassess the unresolved regression concern after retry",
            ],
            "validation_level": "static",
            "regression_status": "unresolved",
            "verification_findings": ["the current patch is incomplete"],
        }
    )

    assert result.patch_coverage == "partial"
    assert result.regression_status == "unresolved"
    assert result.resolution_next_step == "retry-ai"


def test_patch_full_with_blocking_regression_requires_patch_finding() -> None:
    """Require actionable context whenever regression evidence blocks delivery."""
    with pytest.raises(ValueError, match="requires a concrete patch finding"):
        VerificationOutput.model_validate(
            {
                "overview": "Security coverage is full but delivery is blocked.",
                "review_target_claim": "reviewed claim",
                "patch_coverage": "full",
                "resolution_next_step": "manual-review",
                "patch_findings": [],
                "validation_level": "static",
                "regression_status": "failed",
                "verification_findings": ["security target is covered"],
            }
        )


def test_patch_full_without_blocking_regression_rejects_follow_up() -> None:
    """Reject needless follow-up when both security and regression gates are clear."""
    with pytest.raises(ValueError, match="requires resolution_next_step=none"):
        VerificationOutput.model_validate(
            {
                "overview": "Patch fully covers the reviewed claim.",
                "review_target_claim": "reviewed claim",
                "patch_coverage": "full",
                "resolution_next_step": "manual-review",
                "patch_findings": [],
                "validation_level": "static",
                "regression_status": "passed",
                "verification_findings": ["note"],
            }
        )


def test_retry_ai_requires_patch_findings() -> None:
    result = VerificationOutput.model_validate(
        {
            "overview": "Patch partially covers the reviewed claim.",
            "review_target_claim": "reviewed claim",
            "patch_coverage": "partial",
            "resolution_next_step": "retry-ai",
            "patch_findings": ["fix the remaining bypass"],
            "validation_level": "static",
            "regression_status": "not-run",
            "verification_findings": ["note"],
        }
    )

    assert result.resolution_next_step == "retry-ai"


def test_no_patch_can_have_no_next_step() -> None:
    result = VerificationOutput.model_validate(
        {
            "overview": "No patch was available to verify.",
            "review_target_claim": "reviewed claim",
            "patch_coverage": "no-patch",
            "resolution_next_step": "none",
            "patch_findings": [],
            "validation_level": "static",
            "regression_status": "not-applicable",
            "verification_findings": ["No patch was available to verify."],
        }
    )

    assert result.patch_coverage == "no-patch"
    assert result.resolution_next_step == "none"


def test_partial_patch_cannot_have_no_next_step() -> None:
    with pytest.raises(ValueError):
        VerificationOutput.model_validate(
            {
                "overview": "Patch partially covers the reviewed claim.",
                "review_target_claim": "reviewed claim",
                "patch_coverage": "partial",
                "resolution_next_step": "none",
                "patch_findings": ["fix the remaining bypass"],
                "validation_level": "static",
                "regression_status": "not-run",
                "verification_findings": ["note"],
            }
        )


def test_retry_ai_rejects_empty_patch_findings() -> None:
    with pytest.raises(ValueError):
        VerificationOutput.model_validate(
            {
                "overview": "Patch partially covers the reviewed claim.",
                "review_target_claim": "reviewed claim",
                "patch_coverage": "partial",
                "resolution_next_step": "retry-ai",
                "patch_findings": [],
                "validation_level": "static",
                "regression_status": "not-run",
                "verification_findings": ["note"],
            }
        )


def test_manual_review_partial_does_not_require_patch_findings() -> None:
    result = VerificationOutput.model_validate(
        {
            "overview": "Patch partially covers the reviewed claim.",
            "review_target_claim": "reviewed claim",
            "patch_coverage": "partial",
            "resolution_next_step": "manual-review",
            "patch_findings": ["history cleanup"],
            "validation_level": "static",
            "regression_status": "not-run",
            "verification_findings": ["note"],
        }
    )

    assert result.resolution_next_step == "manual-review"
