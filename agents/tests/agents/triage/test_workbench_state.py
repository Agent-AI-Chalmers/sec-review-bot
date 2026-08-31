from sec_review_agents.agents.triage.workbench_state import build_case_from_candidates


def test_triage_case_does_not_emit_promotion_eligibility() -> None:
    candidate = {
        "candidate_id": "cand-1",
        "category": "injection",
        "locations": [{"file": "src/server.js", "line": 10, "label": "sink"}],
        "rationale": "rationale",
        "evidence": ["evidence"],
    }
    case = build_case_from_candidates(
        category="injection",
        summary="Example finding",
        evidence=["same root cause"],
        member_candidates=[candidate],
    )
    assert "vulnerability_type" not in case
    assert "cwe_id" not in case
    assert "cwe_name" not in case
    assert "cwe_rationale" not in case
