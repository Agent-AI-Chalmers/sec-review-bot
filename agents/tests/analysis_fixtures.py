from sec_review_agents.agents.analysis.model import Narrative
from sec_review_agents.review_stages.analysis.result import AnalysisStageResult
from sec_review_agents.review_stages.types import Verdict


def narrative_fixture(
    *,
    verdict: Verdict = "confirmed-vulnerability",
    title: str = "Example finding",
    priority: int = 1,
) -> Narrative:
    """Provide valid narrative context for tests of downstream orchestration.

    These tests select verdicts and ordering; analysis-model validation is tested
    separately. Keep the supporting location, flow, and scope explicit so these
    fixtures also pass the real Temporal converter.
    """
    return Narrative.model_validate(
        {
            "priority": priority,
            "verdict": verdict,
            "title": title,
            "description": "Test finding at the request handler",
            "vulnerability_type": "Injection",
            "validation_level": "static",
            "locations": [{"file": "app.py", "line": 1}],
            "flow_review": {
                "source_facts": ["Request input"],
                "sink_facts": ["Handler operation"],
            },
            "scope_review": {
                "scope_shape": "local-defect",
                "outcome_deciding_control_point": "request handler",
                "scope_analysis": "Checked the request handler.",
            },
        }
    )


def analysis_fixture(
    *,
    verdict: Verdict | None = "confirmed-vulnerability",
    overview: str = "Test analysis",
    narratives: list[Narrative] | None = None,
) -> AnalysisStageResult:
    return AnalysisStageResult(
        overview=overview,
        verdict=verdict,
        narratives=(
            narratives
            if narratives is not None
            else ([narrative_fixture(verdict=verdict)] if verdict is not None else [])
        ),
    )
