import pytest

from tests.integration.llm.skill_cases.models import SkillCase, SkillCaseOutput
from tests.integration.llm.skill_cases.runner import SkillCaseRun, assert_case_oracle


def _case() -> SkillCase:
    return SkillCase.model_validate(
        {
            "schema_version": 1,
            "id": "oracle-requirements",
            "skill": "cryptography-security",
            "reference": "certificate-path-identity.md",
            "modes": ["prompted"],
            "task": "Assess the validation claim.",
            "facts": ["The implementation is unavailable."],
            "expected": {
                "verdict": "not-confirmed",
                "require_proof_gaps": True,
                "explanation_requirements": ["certificate", "unconfirmed"],
                "proof_gap_requirements": ["trust anchor", "reference identity"],
            },
        }
    )


def _run(*, rationale: str, proof_gaps: list[str]) -> SkillCaseRun:
    return SkillCaseRun(
        output=SkillCaseOutput(
            verdict="not-confirmed",
            evidence="The certificate helper is not available.",
            rationale=rationale,
            proof_gaps=proof_gaps,
        ),
        successful_reads=frozenset(),
    )


def test_oracle_requires_every_explanation_and_proof_gap_requirement() -> None:
    case = _case()
    run = _run(
        rationale="The certificate claim is unconfirmed.",
        proof_gaps=["Trust anchor configuration", "Reference identity matching"],
    )

    assert_case_oracle(case, run)


@pytest.mark.parametrize(
    ("rationale", "proof_gaps"),
    [
        (
            "The certificate claim lacks evidence.",
            ["Trust anchor", "Reference identity"],
        ),
        ("The certificate claim is unconfirmed.", ["Trust anchor"]),
    ],
)
def test_oracle_rejects_a_missing_required_concept(
    rationale: str,
    proof_gaps: list[str],
) -> None:
    with pytest.raises(AssertionError):
        assert_case_oracle(_case(), _run(rationale=rationale, proof_gaps=proof_gaps))
