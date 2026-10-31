"""Two-stage issue ablation strategy for local comparison."""

from collections.abc import Mapping
from datetime import timedelta
from pathlib import Path
from typing import Any

from temporalio import activity, workflow

from sec_review_agents.review_stages.analysis.result import AnalysisStageResult
from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from sec_review_agents.review_stages.record import build_review_record
from sec_review_agents.review_stages.repair_target import has_confirmed_repair_target
from sec_review_agents.run_diagnostics.publication import (
    RunDiagnosticPublicationRequest,
    publish_run_diagnostic_activity,
)
from sec_review_agents.runtime.runtime_config import ExecutionRuntimeContext
from sec_review_agents.temporal.support import (
    activity_retry_policy,
)
from sec_review_agents.utils.paths import required_path
from sec_review_agents.workflows.issue.workflow import (
    analyze_issue_activity,
)
from sec_review_agents.workflows.prepared_input import PreparedIssueInput
from sec_review_agents.workflows.review_intent import (
    TEST_CHANGES_ALLOW,
    ReviewObjective,
    TestChangesPolicy,
)
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest


@activity.defn
async def mitigate_issue_self_check_activity(
    request: ReviewWorkflowRequest,
    analysis_result: AnalysisStageResult,
) -> MitigationStageResult:
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.review_stages.mitigation.stage import (
        create_skipped_mitigation_result,
        mitigation_attempt_label,
    )
    from sec_review_agents.review_stages.trajectories import (
        review_trajectories_root,
        review_trajectory_path,
    )
    from sec_review_agents.runtime.setup_bootstrap import (
        setup_declaration_content_for_backend,
    )
    from sec_review_agents.temporal.support import activity_trace_labels
    from sec_review_agents.utils.paths import required_path
    from sec_review_agents.workflows.issue.mitigation_self_check import (
        mitigate_issue_with_self_check,
    )

    prepared_input = request.prepared_input
    assert isinstance(prepared_input, PreparedIssueInput)
    run_artifacts_root = required_path(
        prepared_input.artifact_root_path,
        label="artifact_root_path",
    )
    review_intent = prepared_input.review_intent
    mitigator_artifacts_path = Path(prepared_input.mitigator_artifacts_path)
    if not has_confirmed_repair_target(analysis_result):
        review_trajectory_path(
            review_trajectories_root(run_artifacts_root),
            order=2,
            stage="mitigator",
            attempt=mitigation_attempt_label(None),
        ).unlink(missing_ok=True)
        return create_skipped_mitigation_result(
            mitigator_artifacts_path=mitigator_artifacts_path,
            retry_context=None,
            reason="No confirmed, reparable mitigation target was available from the issue analyzer output.",
        )

    workspace_snapshot_tar_path = required_path(
        prepared_input.workspace_snapshot_tar_path,
        label="workspace_snapshot_tar_path",
    )
    with bind_trace_context(
        **activity_trace_labels(
            workflow_name=request.workflow,
            run_id=request.run_id,
            pass_kind="initial",
            pass_index="0",
        )
    ):
        return await mitigate_issue_with_self_check(
            issue=prepared_input.issue,
            workspace_snapshot_tar_path=workspace_snapshot_tar_path,
            history_path=required_path(
                prepared_input.history_path,
                label="history_path",
            ),
            mitigator_artifacts_path=mitigator_artifacts_path,
            published_trajectory_path=review_trajectory_path(
                review_trajectories_root(run_artifacts_root),
                order=2,
                stage="mitigator",
                attempt=mitigation_attempt_label(None),
            ),
            analysis_result=analysis_result,
            test_changes=review_intent.test_changes,
            runtime_context=request.runtime_context,
            setup_declaration_content=setup_declaration_content_for_backend(
                prepared_input.setup_declaration
            ),
        )


@activity.defn
def build_issue_two_stage_result_activity(
    analysis_result: AnalysisStageResult,
    mitigation_result: MitigationStageResult,
) -> dict[str, Any]:
    return build_issue_two_stage_result(
        analysis_result=analysis_result,
        mitigation_result=mitigation_result,
    )


@workflow.defn
class IssueTwoStageWorkflow:
    @workflow.run
    async def run(self, request: ReviewWorkflowRequest) -> dict[str, Any]:
        prepared_input = request.prepared_input
        assert isinstance(prepared_input, PreparedIssueInput)
        analysis_result = await workflow.execute_activity(
            analyze_issue_activity,
            request,
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        mitigation_result = await workflow.execute_activity(
            mitigate_issue_self_check_activity,
            args=[request, analysis_result],
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        public_result = await workflow.execute_activity(
            build_issue_two_stage_result_activity,
            args=[analysis_result, mitigation_result],
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        artifact_root = required_path(
            prepared_input.artifact_root_path,
            label="artifact_root_path",
        )
        finalized = await workflow.execute_activity(
            publish_run_diagnostic_activity,
            args=[
                RunDiagnosticPublicationRequest(
                    run_id=request.run_id,
                    artifact_root_path=str(artifact_root),
                    review_units=[
                        {
                            "unit_id": "review",
                            "trajectory_root": str(artifact_root / "trajectories"),
                        }
                    ],
                    result=public_result,
                    destination_scheme=request.post_processing.diagnostic_scheme,
                )
            ],
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        return {
            "ok": True,
            "result": public_result,
            "artifact_storage": finalized["artifact_storage"],
        }


async def execute_issue_two_stage(
    *,
    issue: Mapping[str, Any],
    workspace_snapshot_tar_path: Path,
    history_path: Path,
    analyzer_artifacts_path: Path,
    mitigator_artifacts_path: Path,
    review_objective: ReviewObjective,
    test_changes: TestChangesPolicy = TEST_CHANGES_ALLOW,
    runtime_context: ExecutionRuntimeContext | None = None,
    setup_declaration_content: str | None = None,
) -> dict[str, Any]:
    """Run analyzer and self-checking mitigation, then publish their review record."""
    from sec_review_agents.review_stages.mitigation.stage import (
        create_skipped_mitigation_result,
    )
    from sec_review_agents.workflows.issue.analysis import analyze_issue
    from sec_review_agents.workflows.issue.mitigation_self_check import (
        mitigate_issue_with_self_check,
    )

    analysis_result = await analyze_issue(
        issue=issue,
        workspace_snapshot_tar_path=workspace_snapshot_tar_path,
        history_path=history_path,
        analyzer_artifacts_path=analyzer_artifacts_path,
        review_objective=review_objective,
        runtime_context=runtime_context,
        setup_declaration_content=setup_declaration_content,
    )

    if not has_confirmed_repair_target(analysis_result):
        mitigation_result: MitigationStageResult = create_skipped_mitigation_result(
            mitigator_artifacts_path=mitigator_artifacts_path,
            retry_context=None,
            reason="No confirmed, reparable mitigation target was available from the issue analyzer output.",
        )
    else:
        mitigation_result = await mitigate_issue_with_self_check(
            issue=issue,
            workspace_snapshot_tar_path=workspace_snapshot_tar_path,
            history_path=history_path,
            mitigator_artifacts_path=mitigator_artifacts_path,
            analysis_result=analysis_result,
            test_changes=test_changes,
            runtime_context=runtime_context,
            setup_declaration_content=setup_declaration_content,
        )

    return build_issue_two_stage_result(
        analysis_result=analysis_result,
        mitigation_result=mitigation_result,
    )


def build_issue_two_stage_review_record(
    *,
    analysis_result: AnalysisStageResult,
    mitigation_result: MitigationStageResult,
) -> dict[str, Any]:
    return build_review_record(
        analysis_result=analysis_result,
        mitigation_result=mitigation_result,
        verifier_result=None,
        cvss_result=None,
    ).model_dump(mode="json", by_alias=True)


def build_issue_two_stage_result(
    *,
    analysis_result: AnalysisStageResult,
    mitigation_result: MitigationStageResult,
) -> dict[str, Any]:
    return {
        "kind": "issue-two-stage-strategy-result",
        "review_record": build_issue_two_stage_review_record(
            analysis_result=analysis_result,
            mitigation_result=mitigation_result,
        ),
    }


async def run_issue_two_stage_direct(
    request: ReviewWorkflowRequest,
) -> dict[str, Any]:
    analysis_result = await analyze_issue_activity(request)
    mitigation_result = await mitigate_issue_self_check_activity(
        request,
        analysis_result,
    )
    return build_issue_two_stage_result_activity(analysis_result, mitigation_result)


__all__ = [
    "IssueTwoStageWorkflow",
    "build_issue_two_stage_result",
    "build_issue_two_stage_result_activity",
    "build_issue_two_stage_review_record",
    "execute_issue_two_stage",
    "mitigate_issue_self_check_activity",
    "run_issue_two_stage_direct",
]
