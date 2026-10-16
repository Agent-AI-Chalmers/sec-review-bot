import pytest

from tests.integration.llm.skill_cases.models import SkillCase, SkillCaseOutput
from tests.integration.llm.skill_cases.runner import SkillCaseRun, assert_case_oracles


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
            "oracles": {
                "decision": {
                    "verdict": "not-confirmed",
                    "proof_gaps_required": True,
                    "explanation_requirements": ["certificate", "unconfirmed"],
                    "proof_gap_requirements": [
                        "trust anchor",
                        "reference identity",
                    ],
                }
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

    assert_case_oracles(case, run)


def test_discovery_case_can_check_reads_without_a_result_oracle() -> None:
    case = SkillCase.model_validate(
        {
            "schema_version": 1,
            "id": "discovery-only",
            "skill": "cryptography-security",
            "reference": "certificate-path-identity.md",
            "modes": ["discovery"],
            "task": "Select the relevant security material.",
            "facts": ["A certificate chain is validated for a service."],
        }
    )

    assert_case_oracles(
        case,
        _run(rationale="No result oracle is configured.", proof_gaps=[]),
    )


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
        assert_case_oracles(_case(), _run(rationale=rationale, proof_gaps=proof_gaps))
