import json
from pathlib import Path

from sec_review_agents.review_stages.cvss.result import build_skipped_cvss_v4_result
from sec_review_agents.review_stages.cvss.stage import persist_cvss_stage_result


def test_cvss_result_does_not_duplicate_repository_case_id() -> None:
    result = build_skipped_cvss_v4_result(reason="not scoreable")

    assert result["overview"] == "not scoreable"
    assert "summary" not in result
    assert "assessment" not in result


def test_cvss_result_persistence_writes_stage_artifact(tmp_path: Path) -> None:
    result = build_skipped_cvss_v4_result(reason="not scoreable")

    persist_cvss_stage_result(cvss_artifacts_path=tmp_path, result=result)

    result_path = tmp_path / "cvss-v4-result.json"
    assert json.loads(result_path.read_text(encoding="utf-8")) == result
