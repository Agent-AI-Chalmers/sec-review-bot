import pytest

from sec_review_agents.agents.analysis.model import AnalysisOutput, Narrative


def test_vulnerability_decision_requires_source_sink_and_location() -> None:
    with pytest.raises(
        ValueError,
        match=(
            "narratives with verdict=confirmed-vulnerability must include "
            "at least one source fact"
        ),
    ):
        Narrative.model_validate(
            {
                "priority": 1,
                "verdict": "confirmed-vulnerability",
                "title": "vuln",
                "description": "desc",
                "vulnerability_type": "SSRF",
                "validation_level": "static",
                "flow_review": {"sink_facts": ["sink"]},
                "locations": [{"file": "a.py", "line": 1}],
            }
        )


def test_confirmed_defect_decision_accepts_without_vulnerability_proof_fields() -> None:
    narrative = Narrative.model_validate(
        {
            "priority": 1,
            "verdict": "confirmed-defect",
            "title": "defect",
            "description": "desc",
            "vulnerability_type": "SSRF",
            "validation_level": "static",
        }
    )

    assert narrative.verdict == "confirmed-defect"


def test_narrative_control_review_defaults_and_accepts_aliases() -> None:
    default_narrative = Narrative.model_validate(
        {
            "priority": 1,
            "verdict": "no-actionable-finding",
            "title": "safe",
            "description": "desc",
            "validation_level": "static",
        }
    )

    assert default_narrative.control_review.reachable_assets == []
    assert default_narrative.control_review.security_controls == []
    assert default_narrative.control_review.control_limits == []
    assert default_narrative.flow_review.source_facts == []
    assert default_narrative.flow_review.sink_facts == []
    assert default_narrative.support_review.supported_inferences == []
    assert default_narrative.support_review.proof_gaps == []
    assert default_narrative.scope_review.scope_shape == "unresolved"
    assert default_narrative.scope_review.shared_boundary is None
    assert default_narrative.scope_review.reviewed_nearby_paths == []
    assert default_narrative.cwe_mapping.cwe_id is None

    narrative = Narrative.model_validate(
        {
            "priority": 1,
            "verdict": "confirmed-defect",
            "title": "defect",
            "description": "desc",
            "validation_level": "static",
            "control_review": {
                "reachable_assets": ["PATH directory"],
                "security_controls": ["AppArmor deny rule"],
                "control_limits": ["Exact path is not covered."],
            },
        }
    )

    assert narrative.control_review.reachable_assets == ["PATH directory"]
    assert narrative.control_review.security_controls == ["AppArmor deny rule"]
    assert narrative.control_review.control_limits == ["Exact path is not covered."]


def test_narrative_nested_reviews_accept_aliases() -> None:
    narrative = Narrative.model_validate(
        {
            "priority": 1,
            "verdict": "confirmed-vulnerability",
            "title": "vuln",
            "description": "desc",
            "vulnerability_type": "SSRF",
            "validation_level": "static",
            "locations": [{"file": "a.py", "line": 1}],
            "flow_review": {
                "source_facts": ["source"],
                "sink_facts": ["sink"],
            },
            "support_review": {
                "supported_inferences": ["inference"],
                "proof_gaps": ["gap"],
            },
            "scope_review": {
                "scope_shape": "shared-enforcement-point",
                "shared_boundary": "shared helper",
                "reviewed_nearby_paths": [
                    {"label": "helper", "relationship": "same-semantics"}
                ],
            },
            "cwe_mapping": {
                "cwe_id": "CWE-918",
                "cwe_name": "Server-Side Request Forgery",
                "cwe_rationale": "matches",
            },
        }
    )

    assert narrative.flow_review.source_facts == ["source"]
    assert narrative.flow_review.sink_facts == ["sink"]
    assert narrative.support_review.supported_inferences == ["inference"]
    assert narrative.support_review.proof_gaps == ["gap"]
    assert narrative.scope_review.scope_shape == "shared-enforcement-point"
    assert narrative.scope_review.shared_boundary == "shared helper"
    assert narrative.cwe_mapping.cwe_id == "CWE-918"


def test_narrative_rejects_legacy_top_level_review_fields() -> None:
    with pytest.raises(ValueError, match="Extra inputs are not permitted"):
        Narrative.model_validate(
            {
                "priority": 1,
                "verdict": "confirmed-defect",
                "title": "legacy",
                "description": "desc",
                "validation_level": "static",
                "source_facts": ["legacy source"],
            }
        )


def test_analysis_output_orders_narratives_by_priority() -> None:
    output = AnalysisOutput.model_validate(
        {
            "overview": "Confirmed defect.",
            "overall_verdict": "confirmed-defect",
            "narratives": [
                {
                    "priority": 2,
                    "verdict": "confirmed-defect",
                    "title": "second",
                    "description": "desc",
                    "validation_level": "static",
                },
                {
                    "priority": 1,
                    "verdict": "confirmed-defect",
                    "title": "first",
                    "description": "desc",
                    "validation_level": "static",
                },
            ],
        }
    )

    assert [narrative.priority for narrative in output.narratives] == [1, 2]
