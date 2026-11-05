from unittest.mock import patch

import pytest

from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from sec_review_agents.review_stages.verification.result import VerificationStageResult
from sec_review_agents.workflows.issue.direct import run_issue_review_direct
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest
from tests.analysis_fixtures import analysis_fixture
from tests.prepared_input_fixtures import prepared_issue_input


@pytest.mark.asyncio
async def test_direct_review_passes_no_patch_assessment_to_result() -> None:
    analysis_result = analysis_fixture(verdict="no-actionable-finding", narratives=[])
    mitigation_result = MitigationStageResult(
        overview="No confirmed repair target.", file_changes=[], patch_diff=""
    )
    verifier_result = VerificationStageResult(
        overview="No repair justified after independent review.",
        next_step="none",
        target_claim="Whether the reported issue requires repair.",
        coverage="full",
        validation_level="static",
        regression="not-applicable",
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
