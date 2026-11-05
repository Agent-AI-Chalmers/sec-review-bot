import json
from annotationlib import Format, get_annotations
from typing import Any, get_args

import pytest
from pydantic import BaseModel, ValidationError

from sec_review_agents.delivery_stages.result import DeliveryResult
from sec_review_agents.review_stages.cvss import (
    CvssMetricDetail,
    CvssStageResult,
)
from sec_review_agents.review_stages.cvss.result import build_skipped_cvss_v4_result
from sec_review_agents.review_stages.cvss.stage import (
    run_cvss_v4_scoring_stage,
)
from sec_review_agents.review_stages.record import (
    ReviewRecord,
    ReviewRecordAnalysis,
    ReviewRecordCvss,
    ReviewRecordMitigation,
    ReviewRecordVerification,
)
from sec_review_agents.review_stages.single_agent import SingleAgentFixOutcome
from sec_review_agents.review_stages.types import (
    CoverageStatus,
    CvssOutcome,
    NextStep,
    RegressionStatus,
    ValidationLevel,
    Verdict,
)
from sec_review_agents.workflows.issue.single_agent import (
    execute_issue_single_agent,
)
from sec_review_agents.workflows.repository.result import (
    RepositoryWorkflowResult,
    ScanSummary,
    build_repository_workflow_result,
)
from tests.contract_fixtures import contract_schema
from tests.repository_scan_fixtures import scan_result_fixture


def test_review_record_public_contract_tracks_current_shape() -> None:
    review_record = contract_schema("common.schema.json")["$defs"]["reviewRecord"]
    models: dict[str, type[BaseModel]] = {
        "analysis": ReviewRecordAnalysis,
        "mitigation": ReviewRecordMitigation,
        "verification": ReviewRecordVerification,
    }

    for section, model in models.items():
        section_schema = review_record["properties"][section]
        assert set(model.model_fields) == set(section_schema["properties"])
        assert set(model.model_fields) == set(section_schema["required"])

    cvss_schema = review_record["properties"]["cvss"]["anyOf"][1]
    assert set(ReviewRecordCvss.model_fields) == set(cvss_schema["properties"])
    assert set(ReviewRecordCvss.model_fields) == set(cvss_schema["required"])


def test_review_record_enum_allowlists_match_shared_schema() -> None:
    review_record = contract_schema("common.schema.json")["$defs"]["reviewRecord"]
    analysis = review_record["properties"]["analysis"]["properties"]
    verification = review_record["properties"]["verification"]["properties"]
    cvss = review_record["properties"]["cvss"]["anyOf"][1]["properties"]

    expected: dict[str, tuple[tuple[str, ...], list[Any]]] = {
        "verdict": (get_args(Verdict), analysis["verdict"]["enum"]),
        "validation_level": (
            get_args(ValidationLevel),
            verification["validation_level"]["enum"],
        ),
        "coverage": (
            get_args(CoverageStatus),
            verification["coverage"]["enum"],
        ),
        "regression": (
            get_args(RegressionStatus),
            verification["regression"]["enum"],
        ),
        "next_step": (
            get_args(NextStep),
            verification["next_step"]["enum"],
        ),
        "cvss_outcome": (get_args(CvssOutcome), cvss["outcome"]["enum"]),
    }
    for name, (runtime_values, schema_values) in expected.items():
        assert set(runtime_values) == {
            value for value in schema_values if value is not None
        }, name


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
        "regression",
        "target_claim",
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
    assert set(ScanSummary.model_fields) == {
        "scannable_file_count",
        "scanned_file_count",
        "skipped_file_count",
        "candidate_count",
        "case_count",
        "suppressed_candidate_count",
        "deleted_file_count",
    }
    assert set(RepositoryWorkflowResult.model_fields) == {
        "api_version",
        "scan_summary",
        "deliveries",
        "case_results",
        "deletion_review_skipped",
    }


def test_repository_workflow_builder_derives_scan_summary_from_scan_results() -> None:
    result = build_repository_workflow_result(
        scan_result=scan_result_fixture(
            scannable_file_count=10,
            scanned_file_count=8,
            skipped_file_count=2,
            candidate_count=4,
            case_count=3,
            suppressed_candidate_count=1,
            deleted_file_count=5,
            deletion_review_skipped=False,
        ),
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
        "deleted_file_count": 5,
    }
    assert result["deletion_review_skipped"] is False


def test_repository_workflow_builder_emits_json_serializable_public_payload() -> None:
    result = build_repository_workflow_result(
        scan_result=scan_result_fixture(),
        delivery_result=DeliveryResult.model_validate(
            {
                "status": "completed",
                "deliveries": [
                    {
                        "delivery_id": "partial",
                        "case_ids": ["case-1"],
                        "patch_diff": "",
                        "file_changes": [],
                    }
                ],
            }
        ),
        case_results=[],
    )

    assert type(result) is dict
    assert result["deliveries"] == [
        {
            "delivery_id": "partial",
            "case_ids": ["case-1"],
            "patch_diff": "",
            "file_changes": [],
        }
    ]
    json.dumps(result)


def test_repository_cvss_stage_return_annotations_preserve_model() -> None:
    assert (
        get_annotations(build_skipped_cvss_v4_result, format=Format.VALUE)["return"]
        == CvssStageResult
    )
    assert (
        get_annotations(run_cvss_v4_scoring_stage, format=Format.VALUE)["return"]
        == CvssStageResult
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


def test_repository_cvss_stage_builder_retains_optional_scoring_fields() -> None:
    result = build_skipped_cvss_v4_result(reason="Not scoreable.")

    assert isinstance(result, CvssStageResult)
    json.dumps(result.model_dump(mode="json"))
    assert result.version is None
    assert result.vector is None
    assert result.base_score is None
    assert result.severity is None
    assert result.not_scored_reason is None


def test_review_record_cvss_outcome_is_limited_to_the_schema_enum() -> None:
    """An outcome outside the contract enum must not reach the public review record."""
    with pytest.raises(ValidationError) as error:
        ReviewRecord.model_validate(
            {"cvss": {"outcome": "invented", "overview": "Unrecognized outcome."}}
        )
    assert error.value.errors()[0]["loc"] == ("cvss", "outcome")

    known = ReviewRecord.model_validate(
        {"cvss": {"outcome": "not-scored", "overview": "No score."}}
    ).model_dump(mode="json", by_alias=True)
    assert known["cvss"]["outcome"] == "not-scored"


@pytest.mark.parametrize("invalid", ["10", True, 1.5, None])
def test_scan_summary_rejects_invalid_count_instead_of_reporting_zero(invalid) -> None:
    """Invalid internal statistics must not be published as a successful zero count."""
    with pytest.raises(ValidationError, match="scanned_file_count"):
        ScanSummary.model_validate({"scanned_file_count": invalid})
