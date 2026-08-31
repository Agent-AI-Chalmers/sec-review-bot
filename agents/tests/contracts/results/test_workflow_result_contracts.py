import json
from annotationlib import Format, get_annotations
from typing import Any

from sec_review_agents.review_stages.cvss import (
    CvssMetricDetail,
    CvssStageResult,
)
from sec_review_agents.review_stages.cvss.result import build_skipped_cvss_v4_result
from sec_review_agents.review_stages.cvss.stage import (
    run_cvss_v4_scoring_stage,
)
from sec_review_agents.review_stages.record import (
    ReviewRecordAnalysis,
    ReviewRecordVerification,
)
from sec_review_agents.review_stages.single_agent import SingleAgentFixOutcome
from sec_review_agents.workflows.issue.single_agent import (
    execute_issue_single_agent,
)
from sec_review_agents.workflows.repository.result import (
    RepositoryWorkflowResult,
    ScanSummary,
    build_repository_workflow_result,
)


def test_review_record_public_contract_tracks_current_shape() -> None:
    assert set(ReviewRecordAnalysis.model_fields) == {
        "verdict",
        "overview",
        "narratives",
    }
    assert set(ReviewRecordVerification.model_fields) == {
        "overview",
        "review_target_claim",
        "validation_level",
        "patch_coverage",
        "regression_status",
        "resolution_next_step",
        "patch_findings",
        "verification_findings",
        "residual_risks",
    }


def test_issue_single_agent_workflow_return_annotation_is_public_payload() -> None:
    assert (
        get_annotations(execute_issue_single_agent, format=Format.VALUE)["return"]
        == dict[str, Any]
    )


def test_issue_single_agent_contract_tracks_required_sections() -> None:
    assert set(SingleAgentFixOutcome.model_fields) == {
        "overview",
        "verdict",
        "validation_level",
        "regression_status",
        "target_claim",
        "changed_files",
        "file_changes",
        "patch_diff",
        "residual_risks",
        "self_check_notes",
    }


def test_repository_workflow_builder_return_annotation_is_public_payload() -> None:
    assert (
        get_annotations(build_repository_workflow_result, format=Format.VALUE)["return"]
        == dict[str, Any]
    )


def test_repository_workflow_contract_tracks_required_sections() -> None:
    assert set(RepositoryWorkflowResult.model_fields) == {
        "contract_version",
        "scan_summary",
        "deliveries",
        "case_results",
    }
    assert set(ScanSummary.model_fields) == {
        "scannable_file_count",
        "scanned_file_count",
        "skipped_file_count",
        "candidate_count",
        "case_count",
        "suppressed_candidate_count",
    }


def test_repository_workflow_builder_derives_scan_summary_from_scan_results() -> None:
    result = build_repository_workflow_result(
        discovery_result={
            "counts": {
                "scannable_file_count": 10,
                "scanned_file_count": 8,
                "skipped_file_count": 2,
                "candidate_count": 4,
            }
        },
        triage_result={
            "counts": {
                "case_count": 3,
                "suppressed_candidate_count": 1,
            }
        },
        delivery_result=None,
        case_results=[],
    )

    assert result["scan_summary"] == {
        "scannable_file_count": 10,
        "scanned_file_count": 8,
        "skipped_file_count": 2,
        "candidate_count": 4,
        "case_count": 3,
        "suppressed_candidate_count": 1,
    }


def test_repository_workflow_builder_emits_json_serializable_public_payload() -> None:
    result = build_repository_workflow_result(
        discovery_result={"counts": {}},
        triage_result={"counts": {}},
        delivery_result={"deliveries": [{"delivery_id": "partial"}]},
        case_results=[],
    )

    assert type(result) is dict
    assert result["deliveries"] == [{"delivery_id": "partial"}]
    json.dumps(result)


def test_repository_cvss_stage_return_annotations_are_public_payloads() -> None:
    assert (
        get_annotations(build_skipped_cvss_v4_result, format=Format.VALUE)["return"]
        == dict[str, Any]
    )
    assert (
        get_annotations(run_cvss_v4_scoring_stage, format=Format.VALUE)["return"]
        == dict[str, Any]
    )


def test_repository_cvss_stage_compiler_models_track_public_fields() -> None:
    assert set(CvssStageResult.model_fields) == {
        "outcome",
        "overview",
        "version",
        "vector",
        "base_score",
        "severity",
        "metrics",
        "not_scored_reason",
    }
    assert set(CvssMetricDetail.model_fields) == {
        "value",
        "rationale",
    }


def test_repository_cvss_stage_builder_emits_json_serializable_public_payload() -> None:
    result = build_skipped_cvss_v4_result(reason="Not scoreable.")

    assert type(result) is dict
    json.dumps(result)
    assert result["version"] is None
    assert result["vector"] is None
    assert result["base_score"] is None
    assert result["severity"] is None
    assert "not_scored_reason" not in result
