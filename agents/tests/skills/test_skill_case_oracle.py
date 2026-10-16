import pytest
from pydantic import ValidationError

from tests.integration.llm.skill_cases.models import (
    SkillCase,
    SkillCaseOutput,
    SkillVerdict,
)
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
                    "verdict": "unresolved",
                    "explanation_requirements": ["certificate", "unconfirmed"],
                    "proof_gap_requirements": [
                        "trust anchor",
                        "reference identity",
                    ],
                }
            },
        }
    )


def _run(
    *,
    rationale: str,
    proof_gaps: list[str],
    verdict: SkillVerdict = "unresolved",
) -> SkillCaseRun:
    return SkillCaseRun(
        output=SkillCaseOutput(
            verdict=verdict,
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
    ("field", "value"),
    [
        ("explanation_requirements", ["certificate"]),
        ("proof_gap_requirements", ["trust anchor"]),
        ("explanation_requirements", ["certificate", "["]),
    ],
)
def test_decision_oracle_rejects_weak_or_invalid_requirement_sets(
    field: str,
    value: list[str],
) -> None:
    payload = _case().model_dump(mode="json")
    payload["oracles"]["decision"][field] = value

    with pytest.raises(ValidationError):
        SkillCase.model_validate(payload)


@pytest.mark.parametrize(
    ("verdict", "proof_gap_requirements"),
    [
        ("unresolved", []),
        ("rejected", ["trust anchor", "reference identity"]),
        ("confirmed", ["trust anchor", "reference identity"]),
    ],
)
def test_decision_oracle_enforces_verdict_proof_gap_semantics(
    verdict: str,
    proof_gap_requirements: list[str],
) -> None:
    payload = _case().model_dump(mode="json")
    payload["oracles"]["decision"]["verdict"] = verdict
    payload["oracles"]["decision"]["proof_gap_requirements"] = proof_gap_requirements

    with pytest.raises(ValidationError):
        SkillCase.model_validate(payload)


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


def test_rejected_oracle_rejects_material_proof_gaps() -> None:
    payload = _case().model_dump(mode="json")
    payload["oracles"]["decision"]["verdict"] = "rejected"
    payload["oracles"]["decision"]["proof_gap_requirements"] = []
    case = SkillCase.model_validate(payload)
    run = _run(
        verdict="rejected",
        rationale="The certificate claim is unconfirmed.",
        proof_gaps=["Trust anchor configuration"],
    )

    with pytest.raises(AssertionError):
        assert_case_oracles(case, run)
