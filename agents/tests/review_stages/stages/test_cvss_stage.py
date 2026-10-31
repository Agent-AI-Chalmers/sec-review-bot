import json
from pathlib import Path

from sec_review_agents.review_stages.cvss.result import build_skipped_cvss_v4_result
from sec_review_agents.review_stages.cvss.stage import (
    persist_cvss_failure,
    persist_cvss_stage_result,
)
from tests.analysis_fixtures import analysis_fixture


def test_cvss_result_does_not_duplicate_repository_case_id() -> None:
    result = build_skipped_cvss_v4_result(reason="not scoreable")

    assert result.overview == "not scoreable"
    assert "summary" not in result.model_dump()
    assert "assessment" not in result.model_dump()


def test_cvss_result_persistence_writes_stage_artifact(tmp_path: Path) -> None:
    result = build_skipped_cvss_v4_result(reason="not scoreable")

    persist_cvss_stage_result(cvss_artifacts_path=tmp_path, result=result)

    result_path = tmp_path / "cvss-v4-result.json"
    assert json.loads(result_path.read_text(encoding="utf-8")) == result.model_dump(
        exclude={"not_scored_reason"}
    )


def test_cvss_result_and_failure_artifacts_are_mutually_exclusive(
    tmp_path: Path,
) -> None:
    result = build_skipped_cvss_v4_result(reason="not scoreable")
    result_path = tmp_path / "cvss-v4-result.json"
    failure_path = tmp_path / "cvss-v4-failure.json"

    persist_cvss_failure(cvss_artifacts_path=tmp_path, error="model unavailable")

    assert not result_path.exists()
    assert json.loads(failure_path.read_text(encoding="utf-8")) == {
        "error": "model unavailable"
    }

    persist_cvss_stage_result(cvss_artifacts_path=tmp_path, result=result)

    assert json.loads(result_path.read_text(encoding="utf-8")) == result.model_dump(
        exclude={"not_scored_reason"}
    )
    assert not failure_path.exists()


def test_scored_metrics_retain_values_and_rationales_in_artifact(
    tmp_path: Path,
) -> None:
    from sec_review_agents.agents.cvss.model import CvssV4ScoringOutput
    from sec_review_agents.review_stages.cvss.stage import (
        build_cvss_stage_result_from_agent_output,
    )

    metrics = {
        "AV": "N",
        "AC": "L",
        "AT": "N",
        "PR": "N",
        "UI": "N",
        "VC": "H",
        "VI": "H",
        "VA": "H",
        "SC": "N",
        "SI": "N",
        "SA": "N",
    }
    output = CvssV4ScoringOutput.model_validate(
        {
            "overview": "Remote unauthenticated impact",
            **metrics,
            "metric_rationales": [
                {"metric": metric, "rationale": f"Reason for {metric}"}
                for metric in metrics
            ],
        }
    )
    result = build_cvss_stage_result_from_agent_output(output)
    assert result.metrics["AV"].value == "N"
    assert result.metrics["AV"].rationale == "Reason for AV"
    assert result.base_score is not None
    persist_cvss_stage_result(cvss_artifacts_path=tmp_path, result=result)
    artifact = json.loads((tmp_path / "cvss-v4-result.json").read_text())
    assert artifact["metrics"]["AV"] == {"value": "N", "rationale": "Reason for AV"}
    assert "not_scored_reason" not in artifact


def test_unscored_reason_survives_artifact_and_case_record(tmp_path: Path) -> None:
    from sec_review_agents.review_stages.cvss.result import build_cvss_v4_stage_result
    from sec_review_agents.workflows.repository_case.workflow import (
        build_repository_case_result_activity,
    )
    from tests.workflows.repository.test_repository_case_processing_concurrency import (
        repository_case_execution_input,
    )

    result = build_cvss_v4_stage_result(
        outcome="not-scored",
        overview="No independent impact",
        not_scored_reason="Defense in depth",
    )
    persist_cvss_stage_result(cvss_artifacts_path=tmp_path, result=result)
    artifact = json.loads((tmp_path / "cvss-v4-result.json").read_text())
    assert artifact["not_scored_reason"] == "Defense in depth"
    assert artifact["base_score"] is None
    record = build_repository_case_result_activity(
        {
            "case_execution_input": repository_case_execution_input("case-1"),
            "published_trajectories_path": str(tmp_path),
            "artifact_paths": {
                "analyzer": str(tmp_path),
                "cvss": str(tmp_path),
                "mitigator": str(tmp_path),
                "verifier": str(tmp_path),
            },
        },
        analysis_fixture(narratives=[]),
        result,
        None,
        None,
    )["review_record"]
    assert record["cvss"]["outcome"] == "not-scored"
    assert record["cvss"]["overview"] == result.overview
