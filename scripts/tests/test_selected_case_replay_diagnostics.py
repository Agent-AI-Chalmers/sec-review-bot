from pathlib import Path

import pytest
from scripts.replay.repository_selected_cases import _analysis_diagnostics
from sec_review_agents.review_stages.analysis.result import AnalysisStageResult


@pytest.mark.parametrize("verdict", [None, "no-actionable-finding", "confirmed-defect"])
def test_analysis_diagnostics_reads_current_model(tmp_path: Path, verdict):
    path = tmp_path / "cases" / "a" / "analyzer" / "analysis-result.json"
    path.parent.mkdir(parents=True)
    result = AnalysisStageResult(overview="analysis", verdict=verdict)
    path.write_text(result.model_dump_json())
    assert _analysis_diagnostics(tmp_path, "a") == {
        "analysis_artifact_state": "valid",
        "analysis_verdict": verdict,
        "analysis_error": None,
    }


def test_analysis_diagnostics_distinguishes_missing_and_invalid(tmp_path: Path):
    assert _analysis_diagnostics(tmp_path, "a")["analysis_artifact_state"] == "missing"
    path = tmp_path / "cases" / "a" / "analyzer" / "analysis-result.json"
    path.parent.mkdir(parents=True)
    for payload in ["not JSON", '{"status":"completed"}']:
        path.write_text(payload)
        result = _analysis_diagnostics(tmp_path, "a")
        assert result["analysis_artifact_state"] == "invalid"
        assert result["analysis_error"]
