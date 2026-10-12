from typing import Any

import pytest

from sec_review_agents.agents.analysis.model import (
    AnalysisOutput,
    Narrative,
    ScopeReview,
)


def scope_review(**overrides: Any) -> dict[str, Any]:
    """Valid scope review for a finding verdict; most tests below do not exercise scope shape."""
    return {
        "scope_shape": "unresolved",
        "outcome_deciding_control_point": "the checked surface",
        "scope_analysis": "No defect was confirmed for this surface.",
        **overrides,
    }


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
                "scope_review": scope_review(),
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
            "locations": [{"file": "a.py", "line": 1}],
            "scope_review": scope_review(),
        }
    )

    assert narrative.verdict == "confirmed-defect"


def test_scope_analysis_is_required_for_every_narrative() -> None:
    """Every narrative explains its scope; leaving the field out was the cheapest way
    to pass the local-versus-shared decision, which is how a shared control point
    stayed invisible in the issue #96 review."""
    with pytest.raises(ValueError, match="scope_review.scope_analysis"):
        Narrative.model_validate(
            {
                "priority": 1,
                "verdict": "no-actionable-finding",
                "title": "safe",
                "description": "desc",
                "validation_level": "static",
                "scope_review": {"scope_shape": "unresolved"},
            }
        )


def test_finding_verdicts_require_the_control_point() -> None:
    """A finding names what decides its outcome.

    `no-actionable-finding` and `inconclusive` assert no such outcome, so they owe the
    analysis only; forcing a control point there would produce a name that decides
    nothing and drift the field away from its meaning.
    """
    base = {
        "priority": 1,
        "verdict": "confirmed-defect",
        "title": "defect",
        "description": "desc",
        "vulnerability_type": "SSRF",
        "validation_level": "static",
        "locations": [{"file": "a.py", "line": 1}],
    }

    with pytest.raises(
        ValueError,
        match="verdict=confirmed-defect require scope_review.outcome_deciding_control_point",
    ):
        Narrative.model_validate(
            {
                **base,
                "scope_review": scope_review(
                    scope_shape="local-defect",
                    outcome_deciding_control_point=None,
                ),
            }
        )

    narrative = Narrative.model_validate(
        {
            **base,
            "scope_review": scope_review(
                scope_shape="local-defect",
                outcome_deciding_control_point="retry_policy.should_retry",
                scope_analysis="Only the single handler consults this policy.",
            ),
        }
    )
    assert (
        narrative.scope_review.outcome_deciding_control_point
        == "retry_policy.should_retry"
    )

    non_finding = Narrative.model_validate(
        {
            "priority": 1,
            "verdict": "no-actionable-finding",
            "title": "safe",
            "description": "desc",
            "validation_level": "static",
            "scope_review": {
                "scope_shape": "unresolved",
                "scope_analysis": "The endpoint was checked; no defect was confirmed.",
            },
        }
    )
    assert non_finding.scope_review.outcome_deciding_control_point is None


def test_local_scope_rejects_a_same_semantics_related_path() -> None:
    """The scope label must agree with the entries that carry its evidence.

    A same-semantics entry says another entry reaches the same failure class through
    the same boundary, which is what shared scope means; the issue #96 review produced
    exactly this contradiction (local-defect while listing two same-semantics entries).
    A shared boundary argued without such an entry stays valid, so only one direction
    is enforced.
    """
    base = {
        "priority": 1,
        "verdict": "confirmed-defect",
        "title": "defect",
        "description": "desc",
        "vulnerability_type": "SSRF",
        "validation_level": "static",
        "locations": [{"file": "a.py", "line": 1}],
    }

    with pytest.raises(ValueError, match="contradicts a same-semantics related path"):
        Narrative.model_validate(
            {
                **base,
                "scope_review": scope_review(scope_shape="local-defect"),
                "related_paths": [
                    {"label": "sibling throw", "relationship": "same-semantics"}
                ],
            }
        )

    shared_without_entries = Narrative.model_validate(
        {
            **base,
            "scope_review": scope_review(
                scope_shape="shared-enforcement-point",
                outcome_deciding_control_point="classifyPublicationFailure",
                scope_analysis="Sibling throws in the same file reach the same classifier.",
            ),
        }
    )

    assert shared_without_entries.scope_review.scope_shape == "shared-enforcement-point"


def test_narrative_control_review_defaults_and_accepts_aliases() -> None:
    default_narrative = Narrative.model_validate(
        {
            "priority": 1,
            "verdict": "no-actionable-finding",
            "title": "safe",
            "description": "desc",
            "validation_level": "static",
            "scope_review": scope_review(),
        }
    )

    assert default_narrative.control_review.reachable_assets == []
    assert default_narrative.control_review.security_controls == []
    assert default_narrative.control_review.control_limits == []
    assert default_narrative.flow_review.source_facts == []
    assert default_narrative.flow_review.sink_facts == []
    assert default_narrative.support_review.supported_inferences == []
    assert default_narrative.support_review.proof_gaps == []
    assert default_narrative.related_paths == []
    assert default_narrative.cwe_mapping.cwe_id is None

    narrative = Narrative.model_validate(
        {
            "priority": 1,
            "verdict": "confirmed-defect",
            "title": "defect",
            "description": "desc",
            "validation_level": "static",
            "locations": [{"file": "a.py", "line": 1}],
            "scope_review": scope_review(),
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
                "outcome_deciding_control_point": "shared helper",
                "scope_analysis": "All three handlers reach the helper before dispatch.",
            },
            "related_paths": [{"label": "helper", "relationship": "same-semantics"}],
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
    assert narrative.scope_review.outcome_deciding_control_point == "shared helper"
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
                "scope_review": scope_review(),
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
                    "locations": [{"file": "a.py", "line": 1}],
                    "scope_review": scope_review(),
                },
                {
                    "priority": 1,
                    "verdict": "confirmed-defect",
                    "title": "first",
                    "description": "desc",
                    "validation_level": "static",
                    "locations": [{"file": "a.py", "line": 1}],
                    "scope_review": scope_review(),
                },
            ],
        }
    )

    assert [narrative.priority for narrative in output.narratives] == [1, 2]


@pytest.mark.parametrize(
    ("verdict", "owes_control_point"),
    [
        ("no-actionable-finding", False),
        ("inconclusive", False),
        ("plausible-risk", True),
        ("confirmed-defect", True),
        ("confirmed-vulnerability", True),
    ],
)
def test_control_point_obligation_follows_the_verdict(
    verdict: str, owes_control_point: bool
) -> None:
    """Pin which verdicts owe a control point.

    `plausible-risk` is the contested member: it asserts no confirmed defect, but the
    control point that would decide the outcome is already identifiable, so it owes one.
    The field description and this rule must agree, or the model omits a field that the
    validator then rejects.
    """
    scope_review = {
        "scope_shape": "unresolved",
        "scope_analysis": "Checked the handler; nothing settled the boundary.",
    }
    payload = {
        "priority": 1,
        "verdict": verdict,
        "title": "case",
        "description": "desc",
        "vulnerability_type": "authorization bypass",
        "validation_level": "static",
        "locations": [{"file": "a.py", "line": 1}],
        "flow_review": {
            "source_facts": ["request input"],
            "sink_facts": ["shell command"],
        },
        "scope_review": scope_review,
    }

    if owes_control_point:
        with pytest.raises(ValueError, match="outcome_deciding_control_point"):
            Narrative.model_validate(payload)
        payload["scope_review"] = {
            **scope_review,
            "outcome_deciding_control_point": "checkAccess",
        }

    Narrative.model_validate(payload)


def test_local_scope_accepts_related_paths_that_are_not_same_semantics() -> None:
    """Only the contradiction is rejected.

    Distinct and unresolved entries say another site goes somewhere else, which is what a
    local scope looks like; rejecting them would make `local-defect` unprovable.
    """
    narrative = Narrative.model_validate(
        {
            "priority": 1,
            "verdict": "confirmed-defect",
            "title": "defect",
            "description": "desc",
            "validation_level": "static",
            "locations": [{"file": "a.py", "line": 1}],
            "scope_review": {
                "scope_shape": "local-defect",
                "outcome_deciding_control_point": "checkAccess",
                "scope_analysis": "Only this handler consults the policy.",
            },
            "related_paths": [
                {"label": "other entry", "relationship": "different-semantics"},
                {"label": "unclear entry", "relationship": "unresolved"},
            ],
        }
    )

    assert narrative.scope_review.scope_shape == "local-defect"


def test_scope_shape_defaults_to_unresolved() -> None:
    """An unfinished scope review stays visibly unresolved instead of claiming a shape."""
    review = ScopeReview(scope_analysis="Could not settle the boundary.")

    assert review.scope_shape == "unresolved"
    assert review.outcome_deciding_control_point is None
