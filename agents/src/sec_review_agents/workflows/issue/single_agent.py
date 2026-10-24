"""Single-agent issue ablation strategy for local comparison."""

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from temporalio import activity, workflow

from sec_review_agents.review_stages.record import build_review_record
from sec_review_agents.run_diagnostics.publication import (
    RunDiagnosticPublicationRequest,
    publish_run_diagnostic_activity,
)
from sec_review_agents.runtime.runtime_config import ExecutionRuntimeContext
from sec_review_agents.temporal.support import (
    execute_activity,
    prepare_internal_workflow_activity,
)
from sec_review_agents.utils.paths import required_path
from sec_review_agents.workflows.review_intent import (
    ReviewObjective,
    TestChangesPolicy,
    require_review_intent,
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
) -> dict[str, Any]:
    """Run the single-agent stage and return its raw result.

    Shared by the Temporal activity and the direct/public entrypoints so the
    stage wiring lives in one place.
    """
    from sec_review_agents.agents.single_agent import issue as issue_single_agent
    from sec_review_agents.review_stages.single_agent.stage import (
        run_single_agent_stage,
    )

    return await run_single_agent_stage(
        agent_name="issue-single-agent",
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        single_agent_artifacts_path=single_agent_artifacts_path,
        setup_declaration_content=setup_declaration_content,
        build_backend=lambda workspace_root: issue_single_agent.create_issue_single_agent_backend(
            workspace_root=workspace_root,
            history_path=history_path,
            runtime_context=runtime_context,
        ),
        system_prompt=issue_single_agent.build_issue_single_agent_system_prompt(
            review_objective=review_objective,
            test_changes=test_changes,
        ),
        filesystem_system_prompt=(
            issue_single_agent.build_issue_single_agent_filesystem_system_prompt()
        ),
        user_prompt=issue_single_agent.build_issue_single_agent_user_prompt(
            issue=issue,
        ),
        todo_system_prompt=issue_single_agent.build_issue_single_agent_todo_system_prompt(),
        todo_tool_description=(
            issue_single_agent.build_issue_single_agent_todo_tool_description()
        ),
    )


@activity.defn
async def run_issue_single_agent_activity(
    request: ReviewWorkflowRequest,
) -> dict[str, Any]:
    from sec_review_agents.runtime.setup_bootstrap import (
        setup_declaration_content_for_backend,
    )
    from sec_review_agents.utils.paths import required_path

    prepared_input = request.prepared_input
    run_artifacts_root = required_path(
        prepared_input["artifact_root_path"],
        label="artifact_root_path",
    )
    review_intent = require_review_intent(prepared_input.get("review_intent"))
    bundle_paths = prepared_input["bundle_paths"]
    workspace_snapshot_tar_path = required_path(
        bundle_paths["workspace_snapshot_tar_path"],
        label="bundle_paths.workspace_snapshot_tar_path",
    )
    history_path = required_path(
        bundle_paths["history_path"],
        label="bundle_paths.history_path",
    )
    return await run_issue_single_agent(
        issue=prepared_input["issue"],
        workspace_snapshot_tar_path=workspace_snapshot_tar_path,
        history_path=history_path,
        single_agent_artifacts_path=run_artifacts_root / "single-agent",
        review_objective=review_intent.objective,
        test_changes=review_intent.test_changes,
        runtime_context=request.runtime_context,
        setup_declaration_content=setup_declaration_content_for_backend(prepared_input),
    )


@activity.defn
def build_issue_single_agent_result_activity(
    request: ReviewWorkflowRequest,
    single_agent_result: dict[str, Any],
) -> dict[str, Any]:
    from sec_review_agents.utils.files import persist_json_artifact
    from sec_review_agents.utils.paths import required_path

    prepared_input = request.prepared_input
    run_artifacts_root = required_path(
        prepared_input["artifact_root_path"],
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
        await execute_activity(
            prepare_internal_workflow_activity,
            request.workflow,
            request.run_id,
            timeout_seconds=request.timeout_seconds,
        )
        result = await execute_activity(
            run_issue_single_agent_activity,
            request,
            timeout_seconds=request.timeout_seconds,
        )
        public_result = await execute_activity(
            build_issue_single_agent_result_activity,
            request,
            result,
            timeout_seconds=request.timeout_seconds,
        )
        artifact_root = required_path(
            request.prepared_input.get("artifact_root_path"),
            label="artifact_root_path",
        )
        finalized = await execute_activity(
            publish_run_diagnostic_activity,
            RunDiagnosticPublicationRequest(
                run_id=request.run_id,
                artifact_root_path=str(artifact_root),
                review_units=[
                    {
                        "review_unit_id": "review",
                        "transcript_root": str(artifact_root / "transcripts"),
                    }
                ],
                result=public_result,
                publication=request.post_processing.diagnostic_publication,
            ),
            timeout_seconds=request.timeout_seconds,
        )
        return {
            "ok": True,
            "result": public_result,
            "artifact_storage": finalized["artifact_storage"],
        }


def _single_agent_analysis_projection(
    result: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    if not isinstance(result, Mapping):
        return None
    return {
        "status": "completed",
        "overview": result.get("overview"),
        "verdict": result.get("verdict"),
        "validation_level": result.get("validation_level"),
    }


def _single_agent_mitigation_projection(
    result: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    if not isinstance(result, Mapping):
        return None
    file_changes = result.get("file_changes") or []
    changed_files = file_change_paths(file_changes)
    status = (
        "skipped"
        if result.get("verdict") == "no-actionable-finding" and not changed_files
        else "completed"
    )
    return {
        "status": status,
        "overview": result.get("overview"),
        "file_changes": file_changes,
        "patch_diff": result.get("patch_diff"),
    }


def _single_agent_verification_projection(
    result: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    if not isinstance(result, Mapping):
        return None
    patch_coverage = (
        "full" if file_change_paths(result.get("file_changes")) else "not-applicable"
    )
    return {
        "overview": result.get("overview"),
        "validation_level": result.get("validation_level"),
        "patch_coverage": patch_coverage,
        "regression_status": result.get("regression_status")
        or ("not-run" if patch_coverage == "full" else "not-applicable"),
        "resolution_next_step": "none" if patch_coverage == "full" else "manual-review",
        "patch_findings": [],
        "verification_findings": result.get("self_check_notes") or [],
        "residual_risks": result.get("residual_risks") or [],
    }


def build_issue_single_agent_review_record(
    *,
    single_agent_result: Mapping[str, Any],
) -> dict[str, Any]:
    return build_review_record(
        analysis_result=_single_agent_analysis_projection(single_agent_result),
        mitigation_result=_single_agent_mitigation_projection(single_agent_result),
        verifier_result=_single_agent_verification_projection(single_agent_result),
        cvss_result=None,
    )


def build_issue_single_agent_result(
    *,
    single_agent_result: Mapping[str, Any],
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
    prepare_internal_workflow_activity(request.workflow, request.run_id)
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
