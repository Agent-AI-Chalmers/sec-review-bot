from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from sec_review_agents.review_stages.verification.result import VerificationStageResult
from sec_review_agents.workflows.issue.direct import run_issue_review_direct
from sec_review_agents.workflows.issue.workflow import (
    mitigate_issue_activity,
    verify_issue_activity,
)
from sec_review_agents.workflows.prepared_input import PreparedIssueInput
from sec_review_agents.workflows.review_intent import ReviewIntent
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest
from tests.analysis_fixtures import analysis_fixture
from tests.prepared_input_fixtures import prepared_issue_input


@pytest.mark.asyncio
async def test_mitigation_activity_accepts_serialized_artifact_root(
    tmp_path: Path,
) -> None:
    """Activity inputs cross a serialization boundary with string paths."""
    artifact_root = tmp_path / "artifacts"
    prepared_input: PreparedIssueInput = prepared_issue_input(
        artifact_root_path=str(artifact_root),
        mitigator_artifacts_path=str(artifact_root / "mitigator"),
        review_intent=ReviewIntent(objective="audit", test_changes="allow"),
    )

    request = ReviewWorkflowRequest(
        workflow="issue-review",
        run_id="run-test",
        prepared_input=prepared_input,
        timeout_seconds=30,
        runtime_context={},
    )
    result = await mitigate_issue_activity(
        request=request,
        analysis_result=analysis_fixture(verdict=None, narratives=[]),
        retry_context=None,
    )

    assert result.file_changes == []
    assert (artifact_root / "mitigator" / "mitigation-result.json").is_file()


@pytest.mark.asyncio
async def test_direct_review_records_skipped_verification_without_confirmed_target() -> (
    None
):
    analysis_result = analysis_fixture(verdict="no-actionable-finding", narratives=[])
    mitigation_result = MitigationStageResult(
        overview="No confirmed repair target.", file_changes=[], patch_diff=""
    )
    verifier_result = VerificationStageResult(
        overview="Verification skipped.",
        resolution_next_step="none",
        review_target_claim=None,
        patch_coverage=None,
        validation_level=None,
        regression_status=None,
    )
    request = ReviewWorkflowRequest(
        workflow="issue-review",
        run_id="run-no-target",
        prepared_input=prepared_issue_input(),
        timeout_seconds=30,
        runtime_context={},
    )

    with (
        patch(
            "sec_review_agents.workflows.issue.direct.analyze_issue_activity",
            return_value=analysis_result,
        ),
        patch(
            "sec_review_agents.workflows.issue.direct.mitigate_issue_activity",
            return_value=mitigation_result,
        ),
        patch(
            "sec_review_agents.workflows.issue.direct.verify_issue_activity",
            return_value=verifier_result,
        ) as verify_mock,
        patch(
            "sec_review_agents.workflows.issue.direct.build_issue_review_result_activity",
            return_value={"review_record": {}},
        ) as build_result_mock,
    ):
        await run_issue_review_direct(request)

    verify_mock.assert_awaited_once_with(
        request,
        analysis_result,
        mitigation_result,
        None,
    )
    build_result_mock.assert_called_once_with(
        analysis_result,
        mitigation_result,
        verifier_result,
    )


@pytest.mark.asyncio
async def test_verification_activity_persists_skip_without_running_verifier(
    tmp_path: Path,
) -> None:
    artifact_root = tmp_path / "artifacts"
    prepared_input = prepared_issue_input(
        artifact_root_path=str(artifact_root),
        verifier_artifacts_path=str(artifact_root / "verifier"),
    )

    with patch(
        "sec_review_agents.workflows.issue.verification.verify_issue"
    ) as verify_mock:
        result = await verify_issue_activity(
            ReviewWorkflowRequest(
                workflow="issue-review",
                run_id="run-test",
                prepared_input=prepared_input,
                timeout_seconds=30,
                runtime_context={},
            ),
            analysis_fixture(verdict="no-actionable-finding", narratives=[]),
            MitigationStageResult(overview="Test mitigation"),
            None,
        )

    verify_mock.assert_not_called()
    assert result.patch_coverage is None
    assert (artifact_root / "verifier" / "verification-result.json").is_file()
