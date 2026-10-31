from sec_review_agents.agents.discovery.model import (
    DiscoveryCandidate,
    DiscoveryLocation,
)
from sec_review_agents.agents.triage.workbench_state import build_case_from_candidates
from sec_review_agents.scan_stages.discovery.result import DiscoveryCandidateResult


def test_triage_case_does_not_emit_promotion_eligibility() -> None:
    candidate = DiscoveryCandidateResult(
        candidate_id="cand-1",
        candidate=DiscoveryCandidate(
            category="injection",
            description="Candidate signal",
            locations=[DiscoveryLocation(file="src/server.js", line=10, label="sink")],
            evidence=["evidence"],
        ),
        grounding_status="grounded",
    )
    case = build_case_from_candidates(
        category="injection",
        summary="Example finding",
        evidence=["same root cause"],
        member_candidates=[candidate],
    )
    assert "vulnerability_type" not in case.model_dump()
    assert "cwe_id" not in case.model_dump()
    assert "cwe_name" not in case.model_dump()
    assert "cwe_rationale" not in case.model_dump()
