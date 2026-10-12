"""Required text fields reject blank values across the agent output models.

`NonEmptyText` binds that rule once for the structured outputs. These cases pin the
fields that rely on it: a required field satisfied by `"   "` reads as answered while
saying nothing, and the models had already re-derived the weaker `Field(min_length=1)`
per model, which counts characters and lets whitespace through.

Each case validates the same payload twice, so a failure has to come from the blanked
field rather than from an unrelated required field.
"""

import pytest
from pydantic import BaseModel, ValidationError

from sec_review_agents.agents.analysis.model import AnalysisOutput, Narrative
from sec_review_agents.agents.cvss.model import CvssMetricRationale, CvssV4ScoringOutput
from sec_review_agents.agents.discovery.model import (
    DiscoveryCandidate,
    DiscoveryLocation,
)
from sec_review_agents.agents.mitigation.model import MitigationOutput
from sec_review_agents.agents.single_agent.model import SingleAgentFixOutput
from sec_review_agents.agents.verification.model import VerificationOutput

BLANK = "   "

SCOPE_REVIEW = {
    "scope_shape": "unresolved",
    "outcome_deciding_control_point": "checkAccess",
    "scope_analysis": "Checked the handler; no defect was confirmed.",
}

ANALYSIS = {"overview": "Confirmed defect.", "overall_verdict": "no-actionable-finding"}

NARRATIVE = {
    "priority": 1,
    "verdict": "confirmed-defect",
    "title": "defect",
    "description": "desc",
    "locations": [{"file": "src/a.ts"}],
    "scope_review": SCOPE_REVIEW,
}

MITIGATION = {"overview": "Narrowed the trust boundary."}

VERIFICATION = {
    "overview": "Patch matches the claim.",
    "review_target_claim": "The endpoint trusts a request-controlled path.",
    "patch_coverage": "no-patch",
    "resolution_next_step": "none",
    "validation_level": "static",
    "regression_status": "not-run",
}

CVSS = {
    "overview": "Hardening change without an independently scoreable path.",
    "scoring_status": "not-scored",
    "not_scored_reason": "Defense-in-depth only.",
}

CVSS_METRIC = {"metric": "AV", "rationale": "Reachable from the network."}

SINGLE_AGENT = {
    "overview": "No actionable target was confirmed.",
    "verdict": "no-actionable-finding",
    "validation_level": "static",
    "regression_status": "not-run",
    "self_check_notes": ["Ran the focused test."],
    "target_claim": "",
}

DISCOVERY_CANDIDATE = {
    "category": "injection",
    "description": "Request input reaches a shell command.",
    "locations": [{"file": "src/run.ts", "label": "sink"}],
    "evidence": ["exec(userInput)"],
}

DISCOVERY_LOCATION = {"file": "src/run.ts", "label": "sink"}


@pytest.mark.parametrize(
    ("model", "payload", "blank_payload"),
    [
        (AnalysisOutput, ANALYSIS, {**ANALYSIS, "overview": BLANK}),
        (Narrative, NARRATIVE, {**NARRATIVE, "locations": [{"file": BLANK}]}),
        (MitigationOutput, MITIGATION, {**MITIGATION, "overview": BLANK}),
        (VerificationOutput, VERIFICATION, {**VERIFICATION, "overview": BLANK}),
        (
            VerificationOutput,
            VERIFICATION,
            {**VERIFICATION, "review_target_claim": BLANK},
        ),
        (CvssV4ScoringOutput, CVSS, {**CVSS, "overview": BLANK}),
        (CvssMetricRationale, CVSS_METRIC, {**CVSS_METRIC, "rationale": BLANK}),
        (SingleAgentFixOutput, SINGLE_AGENT, {**SINGLE_AGENT, "overview": BLANK}),
        (
            DiscoveryCandidate,
            DISCOVERY_CANDIDATE,
            {**DISCOVERY_CANDIDATE, "category": BLANK},
        ),
        (DiscoveryLocation, DISCOVERY_LOCATION, {**DISCOVERY_LOCATION, "file": BLANK}),
        (DiscoveryLocation, DISCOVERY_LOCATION, {**DISCOVERY_LOCATION, "label": BLANK}),
    ],
    ids=[
        "analysis-overview",
        "analysis-location-file",
        "mitigation-overview",
        "verification-overview",
        "verification-review-target-claim",
        "cvss-overview",
        "cvss-metric-rationale",
        "single-agent-overview",
        "discovery-category",
        "discovery-location-file",
        "discovery-location-label",
    ],
)
def test_required_text_fields_reject_blank_values(
    model: type[BaseModel], payload: dict, blank_payload: dict
) -> None:
    model.model_validate(payload)

    with pytest.raises(ValidationError):
        model.model_validate(blank_payload)


def test_single_agent_target_claim_still_allows_an_empty_claim() -> None:
    """An empty `target_claim` is a real outcome, not a blank field.

    The single-agent reaches cases where no actionable target was confirmed, and its
    field description says to leave the claim empty then. Constraining it would force
    the agent to invent a claim it did not audit, so it stays the one required text
    field where a blank value is deliberate.
    """
    output = SingleAgentFixOutput.model_validate(SINGLE_AGENT)

    assert output.target_claim == ""


def test_non_empty_text_strips_surrounding_whitespace() -> None:
    """The shared type trims, so stored prose carries no accidental padding.

    Rejecting blank values already depends on trimming; asserting the trim keeps that
    behaviour pinned instead of incidental.
    """
    output = MitigationOutput.model_validate({"overview": "  Narrowed the path.  "})

    assert output.overview == "Narrowed the path."
