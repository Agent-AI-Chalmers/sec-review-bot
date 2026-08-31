"""Two-stage issue ablation strategy for local comparison."""

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from temporalio import activity, workflow

from sec_review_agents.review_stages.record import build_review_record
from sec_review_agents.runtime.runtime_config import RunnerRuntimeContext
from sec_review_agents.temporal.support import (
    execute_activity,
    prepare_internal_workflow_activity,
)
from sec_review_agents.workflows.execution_request import InternalWorkflowRequest
from sec_review_agents.workflows.issue.workflow import (
    analyze_issue_activity,
    should_run_issue_mitigation,
)
from sec_review_agents.workflows.review_intent import (
    REPAIR_MODE_TEST_CHANGES_ALLOWED,
    RepairMode,
    ReviewObjective,
    require_review_intent,
)


@activity.defn
async def mitigate_issue_self_check_activity(
    prepared_input: dict[str, Any],
    analysis_result: Mapping[str, Any],
    runtime_context: RunnerRuntimeContext,
) -> dict[str, Any]:
    from sec_review_agents.review_stages.mitigation.stage import (
        create_skipped_mitigation_result,
        mitigation_attempt_label,
    )
    from sec_review_agents.run_artifacts.transcripts import review_stage_transcript_path
    from sec_review_agents.utils.paths import artifact_path, required_path
    from sec_review_agents.workflows.issue.mitigation_self_check import (
        mitigate_issue_with_self_check,
    )

    run_artifacts_root = required_path(
        prepared_input["artifact_root_path"],
        label="artifact_root_path",
    )
    bundle_paths = prepared_input["bundle_paths"]
    review_intent = require_review_intent(prepared_input.get("review_intent"))
    mitigator_artifacts_path = artifact_path(
        prepared_input["artifact_paths"],
        "mitigator",
    )
    if not should_run_issue_mitigation(
        review_objective=review_intent.objective,
        analysis_result=analysis_result,
    ):
        review_stage_transcript_path(
            run_artifacts_root,
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
        bundle_paths["workspace_snapshot_tar_path"],
        label="bundle_paths.workspace_snapshot_tar_path",
    )
    return await mitigate_issue_with_self_check(
        issue=prepared_input["issue"],
        workspace_snapshot_tar_path=workspace_snapshot_tar_path,
        history_path=required_path(
            bundle_paths["history_path"],
            label="bundle_paths.history_path",
        ),
        mitigator_artifacts_path=mitigator_artifacts_path,
        published_transcript_path=review_stage_transcript_path(
            run_artifacts_root,
            order=2,
            stage="mitigator",
            attempt=mitigation_attempt_label(None),
        ),
        analysis_result=analysis_result,
        repair_mode=review_intent.repair_mode,
        runtime_context=runtime_context,
    )


@activity.defn
def build_issue_two_stage_result_activity(
    two_stage_result: dict[str, Any],
) -> dict[str, Any]:
    return build_issue_two_stage_result(
        analysis_result=two_stage_result["analysis_result"],
        mitigation_result=two_stage_result["mitigation_result"],
    )


@workflow.defn
class IssueTwoStageWorkflow:
    @workflow.run
    async def run(self, request: InternalWorkflowRequest) -> dict[str, Any]:
        await execute_activity(
            prepare_internal_workflow_activity,
            request.workflow,
            request.run_id,
            timeout_seconds=request.timeout_seconds,
        )
        prepared_input = request.prepared_input
        runtime_context = request.runtime_context
        analysis_result = await execute_activity(
            analyze_issue_activity,
            prepared_input,
            runtime_context,
            timeout_seconds=request.timeout_seconds,
        )
        mitigation_result = await execute_activity(
            mitigate_issue_self_check_activity,
            prepared_input,
            analysis_result,
            runtime_context,
            timeout_seconds=request.timeout_seconds,
        )
        public_result = await execute_activity(
            build_issue_two_stage_result_activity,
            {
                "analysis_result": analysis_result,
                "mitigation_result": mitigation_result,
            },
            timeout_seconds=request.timeout_seconds,
        )
        return {"ok": True, "result": public_result}


async def run_issue_two_stage(
    *,
    issue: Mapping[str, Any],
    workspace_snapshot_tar_path: Path,
    history_path: Path,
    analyzer_artifacts_path: Path,
    mitigator_artifacts_path: Path,
    review_objective: ReviewObjective,
    repair_mode: RepairMode = REPAIR_MODE_TEST_CHANGES_ALLOWED,
    runtime_context: RunnerRuntimeContext | None = None,
) -> dict[str, Any]:
    """Run analyzer plus self-checking mitigation and return raw stage outputs."""
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
    )

    if not should_run_issue_mitigation(
        review_objective=review_objective,
        analysis_result=analysis_result,
    ):
        mitigation_result: dict[str, Any] = create_skipped_mitigation_result(
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
            repair_mode=repair_mode,
            runtime_context=runtime_context,
        )

    return {
        "analysis_result": analysis_result,
        "mitigation_result": mitigation_result,
    }


def build_issue_two_stage_review_record(
    *,
    analysis_result: Mapping[str, Any],
    mitigation_result: Mapping[str, Any],
) -> dict[str, Any]:
    return build_review_record(
        analysis_result=analysis_result,
        mitigation_result=mitigation_result,
        verifier_result=None,
        cvss_result=None,
    )


def build_issue_two_stage_result(
    *,
    analysis_result: Mapping[str, Any],
    mitigation_result: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "kind": "issue-two-stage-strategy-result",
        "review_record": build_issue_two_stage_review_record(
            analysis_result=analysis_result,
            mitigation_result=mitigation_result,
        ),
    }


async def execute_issue_two_stage(
    *,
    issue: Mapping[str, Any],
    workspace_snapshot_tar_path: Path,
    history_path: Path,
    analyzer_artifacts_path: Path,
    mitigator_artifacts_path: Path,
    review_objective: ReviewObjective,
    repair_mode: RepairMode = REPAIR_MODE_TEST_CHANGES_ALLOWED,
    runtime_context: RunnerRuntimeContext | None = None,
) -> dict[str, Any]:
    """Run the stages and project them into the public ablation result shape."""
    two_stage_result = await run_issue_two_stage(
        issue=issue,
        workspace_snapshot_tar_path=workspace_snapshot_tar_path,
        history_path=history_path,
        analyzer_artifacts_path=analyzer_artifacts_path,
        mitigator_artifacts_path=mitigator_artifacts_path,
        review_objective=review_objective,
        repair_mode=repair_mode,
        runtime_context=runtime_context,
    )
    return build_issue_two_stage_result(
        analysis_result=two_stage_result["analysis_result"],
        mitigation_result=two_stage_result["mitigation_result"],
    )


async def run_issue_two_stage_direct(
    request: InternalWorkflowRequest,
) -> dict[str, Any]:
    prepared_input = request.prepared_input
    runtime_context = request.runtime_context
    prepare_internal_workflow_activity(request.workflow, request.run_id)
    analysis_result = await analyze_issue_activity(prepared_input, runtime_context)
    mitigation_result = await mitigate_issue_self_check_activity(
        prepared_input,
        analysis_result,
        runtime_context,
    )
    return build_issue_two_stage_result_activity(
        {
            "analysis_result": analysis_result,
            "mitigation_result": mitigation_result,
        }
    )


__all__ = [
    "IssueTwoStageWorkflow",
    "build_issue_two_stage_result",
    "build_issue_two_stage_result_activity",
    "build_issue_two_stage_review_record",
    "execute_issue_two_stage",
    "mitigate_issue_self_check_activity",
    "run_issue_two_stage",
    "run_issue_two_stage_direct",
]
