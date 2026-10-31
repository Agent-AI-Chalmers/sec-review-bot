from sec_review_agents.review_stages.analysis.result import AnalysisStageResult


def has_confirmed_repair_target(analysis_result: AnalysisStageResult | None) -> bool:
    """Return whether analysis accepted a narrative as a confirmed repair target."""
    return analysis_result is not None and any(
        narrative.verdict in {"confirmed-vulnerability", "confirmed-defect"}
        for narrative in analysis_result.narratives
    )


__all__ = ["has_confirmed_repair_target"]
