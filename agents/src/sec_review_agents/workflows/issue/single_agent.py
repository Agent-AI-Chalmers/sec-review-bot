"""Single-agent issue ablation strategy for local comparison."""

from collections.abc import Mapping
from datetime import timedelta
from pathlib import Path
from typing import Any

from temporalio import activity, workflow

from sec_review_agents.review_stages.record import (
    ReviewRecord,
    ReviewRecordAnalysis,
    ReviewRecordMitigation,
    ReviewRecordVerification,
)
from sec_review_agents.review_stages.single_agent.result import SingleAgentFixOutcome
from sec_review_agents.review_stages.types import PatchCoverage
from sec_review_agents.run_diagnostics.publication import (
    RunDiagnosticPublicationRequest,
    publish_run_diagnostic_activity,
)
from sec_review_agents.runtime.runtime_config import ExecutionRuntimeContext
from sec_review_agents.temporal.support import (
    activity_retry_policy,
)
from sec_review_agents.utils.paths import required_path
from sec_review_agents.workflows.prepared_input import PreparedIssueInput
from sec_review_agents.workflows.review_intent import (
    ReviewObjective,
    TestChangesPolicy,
)
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest
from sec_review_agents.workspace.file_changes import file_change_paths


async def run_issue_single_agent(
    *,
    issue: Mapping[str, Any],
    workspace_snapshot_tar_path: Path,
    history_path: Path,
    single_agent_artifacts_path: Path,
    review_objective: ReviewObjective,
    test_changes: TestChangesPolicy,
    runtime_context: ExecutionRuntimeContext | None = None,
    setup_declaration_content: str | None = None,
) -> SingleAgentFixOutcome:
    """Run the single-agent stage and return its raw result.

    Shared by the Temporal activity and the direct/public entrypoints so the
    stage wiring lives in one place.
    """
    from sec_review_agents.agents.single_agent.issue import (
        build_issue_single_agent_backend_config,
        build_issue_single_agent_filesystem_system_prompt,
        build_issue_single_agent_system_prompt,
        build_issue_single_agent_todo_system_prompt,
        build_issue_single_agent_todo_tool_description,
        build_issue_single_agent_user_prompt,
    )
    from sec_review_agents.review_stages.single_agent.stage import (
        run_single_agent_stage,
    )

    return await run_single_agent_stage(
        agent_name="issue-single-agent",
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        single_agent_artifacts_path=single_agent_artifacts_path,
        setup_declaration_content=setup_declaration_content,
        build_backend_config=lambda workspace_root: build_issue_single_agent_backend_config(
            workspace_root=workspace_root,
            history_path=history_path,
            runtime_context=runtime_context,
        ),
        system_prompt=build_issue_single_agent_system_prompt(
            review_objective=review_objective,
            test_changes=test_changes,
        ),
        filesystem_system_prompt=build_issue_single_agent_filesystem_system_prompt(),
        user_prompt=build_issue_single_agent_user_prompt(
            issue=issue,
        ),
        todo_system_prompt=build_issue_single_agent_todo_system_prompt(),
        todo_tool_description=build_issue_single_agent_todo_tool_description(),
    )


@activity.defn
async def run_issue_single_agent_activity(
    request: ReviewWorkflowRequest,
) -> SingleAgentFixOutcome:
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.runtime.setup_bootstrap import (
        setup_declaration_content_for_backend,
    )
    from sec_review_agents.temporal.support import activity_trace_labels
    from sec_review_agents.utils.paths import required_path

    prepared_input = request.prepared_input
    assert isinstance(prepared_input, PreparedIssueInput)
    run_artifacts_root = required_path(
        prepared_input.artifact_root_path,
        label="artifact_root_path",
    )
    review_intent = prepared_input.review_intent
    workspace_snapshot_tar_path = required_path(
        prepared_input.workspace_snapshot_tar_path,
        label="workspace_snapshot_tar_path",
    )
    history_path = required_path(
        prepared_input.history_path,
        label="history_path",
    )
    with bind_trace_context(
        **activity_trace_labels(
            workflow_name=request.workflow,
            run_id=request.run_id,
            pass_kind="initial",
            pass_index="0",
        )
    ):
        return await run_issue_single_agent(
            issue=prepared_input.issue,
            workspace_snapshot_tar_path=workspace_snapshot_tar_path,
            history_path=history_path,
            single_agent_artifacts_path=run_artifacts_root / "single-agent",
            review_objective=review_intent.objective,
            test_changes=review_intent.test_changes,
            runtime_context=request.runtime_context,
            setup_declaration_content=setup_declaration_content_for_backend(
                prepared_input.setup_declaration
            ),
        )


@activity.defn
def build_issue_single_agent_result_activity(
    request: ReviewWorkflowRequest,
    single_agent_result: SingleAgentFixOutcome,
) -> dict[str, Any]:
    from sec_review_agents.utils.files import persist_json_artifact
    from sec_review_agents.utils.paths import required_path

    prepared_input = request.prepared_input
    assert isinstance(prepared_input, PreparedIssueInput)
    run_artifacts_root = required_path(
        prepared_input.artifact_root_path,
        label="artifact_root_path",
    )
    result = build_issue_single_agent_result(single_agent_result=single_agent_result)
    persist_json_artifact(
        run_artifacts_root / "single-agent",
        "single-agent-result",
        result,
    )
    return result


@workflow.defn
class IssueSingleAgentWorkflow:
    @workflow.run
    async def run(self, request: ReviewWorkflowRequest) -> dict[str, Any]:
        result = await workflow.execute_activity(
            run_issue_single_agent_activity,
            args=[request],
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        public_result = await workflow.execute_activity(
            build_issue_single_agent_result_activity,
            args=[request, result],
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        artifact_root = required_path(
            request.prepared_input.artifact_root_path,
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


def build_issue_single_agent_review_record(
    *,
    single_agent_result: SingleAgentFixOutcome,
) -> dict[str, Any]:
    patch_coverage: PatchCoverage = (
        "full"
        if file_change_paths(single_agent_result.file_changes)
        else "not-applicable"
    )
    return ReviewRecord(
        analysis=ReviewRecordAnalysis(
            overview=single_agent_result.overview,
            verdict=single_agent_result.verdict,
        ),
        mitigation=ReviewRecordMitigation(
            overview=single_agent_result.overview,
            file_changes=single_agent_result.file_changes,
            patch_diff=single_agent_result.patch_diff,
        ),
        verification=ReviewRecordVerification(
            overview=single_agent_result.overview,
            validation_level=single_agent_result.validation_level,
            patch_coverage=patch_coverage,
            regression_status=single_agent_result.regression_status,
            resolution_next_step=(
                "none" if patch_coverage == "full" else "manual-review"
            ),
            verification_findings=single_agent_result.self_check_notes,
            residual_risks=single_agent_result.residual_risks,
        ),
    ).model_dump(mode="json", by_alias=True)


def build_issue_single_agent_result(
    *,
    single_agent_result: SingleAgentFixOutcome,
) -> dict[str, Any]:
    return {
        "kind": "issue-single-agent-strategy-result",
        "review_record": build_issue_single_agent_review_record(
            single_agent_result=single_agent_result,
        ),
    }


async def execute_issue_single_agent(
    *,
    issue: Mapping[str, Any],
    workspace_snapshot_tar_path: Path,
    history_path: Path,
    single_agent_artifacts_path: Path,
    review_objective: ReviewObjective,
    test_changes: TestChangesPolicy,
    runtime_context: ExecutionRuntimeContext | None = None,
    setup_declaration_content: str | None = None,
) -> dict[str, Any]:
    """Run the stage and project it into the public ablation result shape."""
    single_agent_result = await run_issue_single_agent(
        issue=issue,
        workspace_snapshot_tar_path=workspace_snapshot_tar_path,
        history_path=history_path,
        single_agent_artifacts_path=single_agent_artifacts_path,
        review_objective=review_objective,
        test_changes=test_changes,
        runtime_context=runtime_context,
        setup_declaration_content=setup_declaration_content,
    )
    result = build_issue_single_agent_result(single_agent_result=single_agent_result)
    from sec_review_agents.utils.files import persist_json_artifact

    persist_json_artifact(
        single_agent_artifacts_path,
        "single-agent-result",
        result,
    )
    return result


async def run_issue_single_agent_direct(
    request: ReviewWorkflowRequest,
) -> dict[str, Any]:
    single_agent_result = await run_issue_single_agent_activity(request)
    return build_issue_single_agent_result_activity(
        request,
        single_agent_result,
    )


__all__ = [
    "IssueSingleAgentWorkflow",
    "build_issue_single_agent_result",
    "build_issue_single_agent_result_activity",
    "build_issue_single_agent_review_record",
    "execute_issue_single_agent",
    "run_issue_single_agent_activity",
    "run_issue_single_agent_direct",
]
