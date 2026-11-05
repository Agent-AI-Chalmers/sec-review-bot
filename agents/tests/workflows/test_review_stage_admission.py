from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from sec_review_agents.review_stages.feedback_loop import feedback_retry_context
from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from sec_review_agents.review_stages.types import Verdict
from sec_review_agents.review_stages.verification.result import VerificationStageResult
from sec_review_agents.workflows.issue.workflow import (
    mitigate_issue_activity,
    verify_issue_activity,
)
from sec_review_agents.workflows.pull_request.workflow import (
    mitigate_pull_request_activity,
    verify_pull_request_activity,
)
from sec_review_agents.workflows.repository_case.input import (
    PreparedRepositoryCase,
    RepositoryCaseArtifactPaths,
    RepositoryCaseExecutionInput,
)
from sec_review_agents.workflows.repository_case.workflow import (
    RepositoryCaseReviewRequest,
    mitigate_repository_case_activity,
    verify_repository_case_activity,
)
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest
from tests.analysis_fixtures import analysis_fixture
from tests.prepared_input_fixtures import (
    prepared_issue_input,
    prepared_pull_request_input,
)


@pytest.mark.asyncio
@pytest.mark.parametrize("scope", ["issue", "pull_request", "repository_case"])
@pytest.mark.parametrize(
    "verdict",
    [
        "confirmed-vulnerability",
        "confirmed-defect",
        "plausible-risk",
        "inconclusive",
        "no-actionable-finding",
    ],
)
@pytest.mark.parametrize("retry", [False, True], ids=["initial", "feedback"])
async def test_analysis_verdict_does_not_prevent_stage_execution(
    tmp_path: Path, scope: str, verdict: Verdict, retry: bool
) -> None:
    """Run real activity wrappers so an analyzer verdict cannot veto later evidence."""
    analysis = analysis_fixture(verdict=verdict)
    mitigation = MitigationStageResult(overview="No safe repair identified.")
    verification = VerificationStageResult(
        overview="Found an in-scope repair target despite the earlier assessment.",
        review_target_claim="Caller input reaches an unchecked parser.",
        patch_coverage="no-patch",
        resolution_next_step="retry-ai",
        patch_findings=["Validate caller input at the parser boundary."],
        validation_level="static",
        regression_status="not-applicable",
    )
    feedback = (
        feedback_retry_context(
            retry_index=1,
            mitigation_result=mitigation,
            verifier_result=verification,
        )
        if retry
        else None
    )
    mit_mock = AsyncMock(return_value=mitigation)
    ver_mock = AsyncMock(return_value=verification)
    if scope == "repository_case":
        case_input = RepositoryCaseExecutionInput(
            case_id="case-1",
            review_input="Check the reported parser boundary.",
            workspace_snapshot_tar_path=str(tmp_path / "snapshot.tar"),
            history_path=str(tmp_path / "history"),
            scan_mode="full",
            incremental_window_path=None,
            test_changes="allow",
        )
        prepared = PreparedRepositoryCase(
            case_execution_input=case_input,
            artifact_paths=RepositoryCaseArtifactPaths(
                analyzer=str(tmp_path / "analyzer"),
                cvss=str(tmp_path / "cvss"),
                mitigator=str(tmp_path / "mitigator"),
                verifier=str(tmp_path / "verifier"),
            ),
            published_trajectories_path=str(tmp_path / "trajectories"),
        )
        case_request = RepositoryCaseReviewRequest(
            run_id="admission-probe",
            case_execution_input=case_input,
            cases_artifacts_path=str(tmp_path),
            published_trajectories_path=str(tmp_path / "trajectories"),
            timeout_seconds=30,
            runtime_context={},
        )
        with (
            patch(
                "sec_review_agents.workflows.repository_case.stage.run_repository_case_mitigation_stage",
                mit_mock,
            ),
            patch(
                "sec_review_agents.workflows.repository_case.stage.run_repository_case_verification_stage",
                ver_mock,
            ),
        ):
            assert (
                await mitigate_repository_case_activity(
                    case_request, prepared, analysis, feedback
                )
                is mitigation
            )
            assert (
                await verify_repository_case_activity(
                    case_request, prepared, analysis, mitigation, feedback
                )
                is verification
            )
        assert mit_mock.call_args.args[1] is analysis
        assert mit_mock.call_args.args[2] is feedback
        assert ver_mock.call_args.args[1] is analysis
        assert ver_mock.call_args.args[3] is feedback
    else:
        fields = {
            "artifact_root_path": str(tmp_path),
            "workspace_snapshot_tar_path": str(tmp_path / "snapshot.tar"),
            "history_path": str(tmp_path / "history"),
            "mitigator_artifacts_path": str(tmp_path / "mitigator"),
            "verifier_artifacts_path": str(tmp_path / "verifier"),
        }
        request = ReviewWorkflowRequest(
            workflow="issue-review" if scope == "issue" else "pull-request-review",
            run_id="admission-probe",
            timeout_seconds=30,
            runtime_context={},
            prepared_input=(
                prepared_issue_input(**fields)
                if scope == "issue"
                else prepared_pull_request_input(**fields)
            ),
        )
        if scope == "issue":
            mit_activity, ver_activity = mitigate_issue_activity, verify_issue_activity
        else:
            mit_activity, ver_activity = (
                mitigate_pull_request_activity,
                verify_pull_request_activity,
            )
        with (
            patch(
                f"sec_review_agents.workflows.{scope}.mitigation.mitigate_{scope}",
                mit_mock,
            ),
            patch(
                f"sec_review_agents.workflows.{scope}.verification.verify_{scope}",
                ver_mock,
            ),
        ):
            assert await mit_activity(request, analysis, feedback) is mitigation
            assert (
                await ver_activity(request, analysis, mitigation, feedback)
                is verification
            )
        assert mit_mock.call_args.kwargs["analysis_result"] is analysis
        assert mit_mock.call_args.kwargs["retry_context"] is feedback
        assert ver_mock.call_args.kwargs["analysis_result"] is analysis
        assert ver_mock.call_args.kwargs["retry_context"] is feedback
    mit_mock.assert_awaited_once()
    ver_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_verifier_feedback_repairs_rejected_analysis_without_rewriting_it(
    tmp_path: Path,
) -> None:
    """Exercise orchestration and real wrappers so the original verdict cannot veto retry."""
    from sec_review_agents.workflows.issue.direct import run_issue_review_direct
    from sec_review_agents.workflows.repository_case.stage import (
        derive_case_disposition,
    )

    analysis = analysis_fixture(verdict="no-actionable-finding", narratives=[])
    no_patch = MitigationStageResult(overview="No safe repair identified.")
    repaired = MitigationStageResult(
        overview="Repaired the verifier's concrete finding.",
        file_changes=[{"path": "app.py", "status": "deleted"}],
        patch_diff="diff --git a/app.py b/app.py\n",
    )
    blocker = VerificationStageResult(
        overview="The unmodified parser has a concrete unchecked input path.",
        review_target_claim="Caller input reaches an unchecked parser.",
        patch_coverage="no-patch",
        resolution_next_step="retry-ai",
        patch_findings=["Validate caller input at the parser boundary."],
        validation_level="static",
        regression_status="not-applicable",
    )
    approved = blocker.model_copy(
        update={
            "overview": "The repair covers the target.",
            "patch_coverage": "full",
            "resolution_next_step": "none",
            "patch_findings": [],
            "regression_status": "passed",
        }
    )
    request = ReviewWorkflowRequest(
        workflow="issue-review",
        run_id="feedback-admission-probe",
        timeout_seconds=30,
        runtime_context={},
        prepared_input=prepared_issue_input(
            artifact_root_path=str(tmp_path),
            mitigator_artifacts_path=str(tmp_path / "mitigator"),
            verifier_artifacts_path=str(tmp_path / "verifier"),
        ),
    )
    with (
        patch(
            "sec_review_agents.workflows.issue.analysis.analyze_issue",
            AsyncMock(return_value=analysis),
        ) as analyze,
        patch(
            "sec_review_agents.workflows.issue.mitigation.mitigate_issue",
            AsyncMock(side_effect=[no_patch, repaired]),
        ) as mitigate,
        patch(
            "sec_review_agents.workflows.issue.verification.verify_issue",
            AsyncMock(side_effect=[blocker, approved]),
        ) as verify,
    ):
        result = await run_issue_review_direct(request)
    analyze.assert_awaited_once()
    assert mitigate.await_count == verify.await_count == 2
    assert mitigate.call_args_list[0].kwargs["retry_context"] is None
    retry = mitigate.call_args_list[1].kwargs["retry_context"]
    assert retry.retry_index == 1
    assert (
        retry.previous_verifier_summary.review_target_claim
        == blocker.review_target_claim
    )
    assert retry.previous_verifier_summary.patch_findings == blocker.patch_findings
    assert mitigate.call_args_list[1].kwargs["analysis_result"] is analysis
    assert verify.call_args_list[1].kwargs["retry_context"] is retry
    assert result["review_record"]["analysis"]["verdict"] == "no-actionable-finding"
    assert result["review_record"]["verification"]["patch_coverage"] == "full"
    assert derive_case_disposition(repaired, approved)["disposition"] == "keep"
