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


def test_patch_full_may_still_include_patch_findings() -> None:
    result = VerificationOutput.model_validate(
        {
            "overview": "Patch fully covers the reviewed claim.",
            "review_target_claim": "reviewed claim",
            "patch_coverage": "full",
            "resolution_next_step": "none",
            "patch_findings": ["compatibility note"],
            "validation_level": "static",
            "regression_status": "unresolved",
            "verification_findings": ["note"],
        }
    )

    assert result.patch_findings == ["compatibility note"]
    assert result.regression_status == "unresolved"


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
