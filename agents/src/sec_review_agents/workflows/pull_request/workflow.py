from collections.abc import Mapping
from typing import Any

from temporalio import activity, workflow

from sec_review_agents.memory.extraction_workflow import (
    register_memory_extraction_for_review,
)
from sec_review_agents.review_stages.feedback_loop import (
    MAX_FEEDBACK_RETRY_ATTEMPTS,
    feedback_retry_context,
    should_retry_from_verifier_result,
)
from sec_review_agents.runtime.runtime_config import RunnerRuntimeContext
from sec_review_agents.temporal.support import (
    execute_activity,
    prepare_internal_workflow_activity,
)
from sec_review_agents.workflows.execution_request import InternalWorkflowRequest
from sec_review_agents.workflows.review_intent import (
    REVIEW_OBJECTIVE_AUDIT,
    require_review_intent,
)


@activity.defn
async def analyze_pull_request_activity(
    prepared_input: dict[str, Any],
    runtime_context: RunnerRuntimeContext,
) -> dict[str, Any]:
    from sec_review_agents.run_artifacts.transcripts import review_stage_transcript_path
    from sec_review_agents.utils.paths import artifact_path, required_path
    from sec_review_agents.workflows.pull_request.analysis import (
        analyze_pull_request,
    )

    review_intent = require_review_intent(prepared_input.get("review_intent"))
    if review_intent.objective != REVIEW_OBJECTIVE_AUDIT:
        raise ValueError("review_intent.objective must be 'audit'.")
    run_artifacts_root = required_path(
        prepared_input["artifact_root_path"],
        label="artifact_root_path",
    )
    bundle_paths = prepared_input["bundle_paths"]
    workspace_snapshot_tar_path = required_path(
        bundle_paths["workspace_snapshot_tar_path"],
        label="bundle_paths.workspace_snapshot_tar_path",
    )
    return await analyze_pull_request(
        pr=prepared_input["pr"],
        workspace_snapshot_tar_path=workspace_snapshot_tar_path,
        history_path=required_path(
            bundle_paths["history_path"],
            label="bundle_paths.history_path",
        ),
        incremental_window_path=required_path(
            bundle_paths["incremental_window_path"],
            label="bundle_paths.incremental_window_path",
        ),
        analyzer_artifacts_path=artifact_path(
            prepared_input["artifact_paths"],
            "analyzer",
        ),
        published_transcript_path=review_stage_transcript_path(
            run_artifacts_root,
            order=1,
            stage="analyzer",
        ),
        runtime_context=runtime_context,
    )


@activity.defn
async def mitigate_pull_request_activity(
    prepared_input: dict[str, Any],
    analysis_result: dict[str, Any],
    retry_context: dict[str, Any] | None,
    runtime_context: RunnerRuntimeContext,
) -> dict[str, Any]:
    from sec_review_agents.review_stages.mitigation.stage import (
        create_skipped_mitigation_result,
        mitigation_attempt_label,
    )
    from sec_review_agents.run_artifacts.transcripts import (
        retry_stage_order,
        review_stage_transcript_path,
    )
    from sec_review_agents.utils.paths import artifact_path, required_path
    from sec_review_agents.workflows.pull_request.mitigation import (
        mitigate_pull_request,
    )

    review_intent = require_review_intent(prepared_input.get("review_intent"))
    if review_intent.objective != REVIEW_OBJECTIVE_AUDIT:
        raise ValueError("review_intent.objective must be 'audit'.")

    mitigator_artifacts_path = artifact_path(
        prepared_input["artifact_paths"],
        "mitigator",
    )
    run_artifacts_root = required_path(
        prepared_input["artifact_root_path"],
        label="artifact_root_path",
    )
    if not _should_run_pr_mitigation(analysis_result):
        review_stage_transcript_path(
            run_artifacts_root,
            order=retry_stage_order(stage="mitigator", retry_context=retry_context),
            stage="mitigator",
            attempt=mitigation_attempt_label(retry_context),
        ).unlink(missing_ok=True)
        return create_skipped_mitigation_result(
            mitigator_artifacts_path=mitigator_artifacts_path,
            retry_context=retry_context,
            reason="No confirmed, reparable mitigation target was available from the analyzer output.",
        )
    bundle_paths = prepared_input["bundle_paths"]
    return await mitigate_pull_request(
        pr=prepared_input["pr"],
        workspace_snapshot_tar_path=required_path(
            bundle_paths["workspace_snapshot_tar_path"],
            label="bundle_paths.workspace_snapshot_tar_path",
        ),
        history_path=required_path(
            bundle_paths["history_path"],
            label="bundle_paths.history_path",
        ),
        incremental_window_path=required_path(
            bundle_paths["incremental_window_path"],
            label="bundle_paths.incremental_window_path",
        ),
        mitigator_artifacts_path=mitigator_artifacts_path,
        published_transcript_path=review_stage_transcript_path(
            run_artifacts_root,
            order=retry_stage_order(stage="mitigator", retry_context=retry_context),
            stage="mitigator",
            attempt=mitigation_attempt_label(retry_context),
        ),
        analysis_result=analysis_result,
        retry_context=retry_context,
        repair_mode=review_intent.repair_mode,
        runtime_context=runtime_context,
    )


@activity.defn
async def verify_pull_request_activity(
    prepared_input: dict[str, Any],
    analysis_result: dict[str, Any],
    mitigation_result: dict[str, Any] | None,
    retry_context: dict[str, Any] | None,
    runtime_context: RunnerRuntimeContext,
) -> dict[str, Any]:
    from sec_review_agents.review_stages.verification.stage import (
        verification_attempt_label,
    )
    from sec_review_agents.run_artifacts.transcripts import (
        retry_stage_order,
        review_stage_transcript_path,
    )
    from sec_review_agents.utils.paths import artifact_path, required_path
    from sec_review_agents.workflows.pull_request.verification import (
        verify_pull_request,
    )

    run_artifacts_root = required_path(
        prepared_input["artifact_root_path"],
        label="artifact_root_path",
    )
    bundle_paths = prepared_input["bundle_paths"]
    workspace_snapshot_tar_path = required_path(
        bundle_paths["workspace_snapshot_tar_path"],
        label="bundle_paths.workspace_snapshot_tar_path",
    )
    return await verify_pull_request(
        pr=prepared_input["pr"],
        workspace_snapshot_tar_path=workspace_snapshot_tar_path,
        history_path=required_path(
            bundle_paths["history_path"],
            label="bundle_paths.history_path",
        ),
        incremental_window_path=required_path(
            bundle_paths["incremental_window_path"],
            label="bundle_paths.incremental_window_path",
        ),
        verifier_artifacts_path=artifact_path(
            prepared_input["artifact_paths"],
            "verifier",
        ),
        published_transcript_path=review_stage_transcript_path(
            run_artifacts_root,
            order=retry_stage_order(stage="verifier", retry_context=retry_context),
            stage="verifier",
            attempt=verification_attempt_label(retry_context),
        ),
        analysis_result=analysis_result,
        mitigation_result=mitigation_result,
        retry_context=retry_context,
        runtime_context=runtime_context,
    )


@activity.defn
def archive_pull_request_feedback_attempt_activity(
    prepared_input: dict[str, Any],
    retry_context: dict[str, Any],
) -> None:
    from sec_review_agents.run_artifacts.stage import (
        archive_current_feedback_attempt,
    )
    from sec_review_agents.utils.paths import artifact_path

    archive_current_feedback_attempt(
        mitigator_root=artifact_path(prepared_input["artifact_paths"], "mitigator"),
        verifier_root=artifact_path(prepared_input["artifact_paths"], "verifier"),
        retry_context=retry_context,
    )


@activity.defn
def build_pull_request_review_result_activity(
    analysis_result: Mapping[str, Any],
    mitigation_result: Mapping[str, Any] | None,
    verifier_result: Mapping[str, Any] | None,
) -> dict[str, Any]:
    from sec_review_agents.review_stages.record import build_review_record

    return {
        "contract_version": "v4",
        "review_record": build_review_record(
            analysis_result=analysis_result,
            mitigation_result=mitigation_result,
            verifier_result=verifier_result,
            cvss_result=None,
        ),
    }


@workflow.defn
class PullRequestReviewWorkflow:
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
            analyze_pull_request_activity,
            prepared_input,
            runtime_context,
            timeout_seconds=request.timeout_seconds,
        )
        mitigation_result = await execute_activity(
            mitigate_pull_request_activity,
            prepared_input,
            analysis_result,
            None,
            runtime_context,
            timeout_seconds=request.timeout_seconds,
        )
        verifier_result = await execute_activity(
            verify_pull_request_activity,
            prepared_input,
            analysis_result,
            mitigation_result,
            None,
            runtime_context,
            timeout_seconds=request.timeout_seconds,
        )
        retry_count = 0
        history: list[dict[str, Any]] = []
        while (
            retry_count < MAX_FEEDBACK_RETRY_ATTEMPTS
            and should_retry_from_verifier_result(
                mitigation_result,
                verifier_result,
            )
        ):
            retry_count += 1
            retry_context = feedback_retry_context(
                retry_index=retry_count,
                mitigation_result=mitigation_result,
                verifier_result=verifier_result,
                history=history,
            )
            history = retry_context["history"]
            await execute_activity(
                archive_pull_request_feedback_attempt_activity,
                prepared_input,
                retry_context,
                timeout_seconds=request.timeout_seconds,
            )
            mitigation_result = await execute_activity(
                mitigate_pull_request_activity,
                prepared_input,
                analysis_result,
                retry_context,
                runtime_context,
                timeout_seconds=request.timeout_seconds,
            )
            verifier_result = await execute_activity(
                verify_pull_request_activity,
                prepared_input,
                analysis_result,
                mitigation_result,
                retry_context,
                runtime_context,
                timeout_seconds=request.timeout_seconds,
            )
        result = await execute_activity(
            build_pull_request_review_result_activity,
            analysis_result,
            mitigation_result,
            verifier_result,
            timeout_seconds=request.timeout_seconds,
        )
        await register_memory_extraction_for_review(request)
        return {"ok": True, "result": result}


def _should_run_pr_mitigation(analysis_result: Mapping[str, Any] | None) -> bool:
    narratives = (analysis_result or {}).get("narratives")
    if not isinstance(narratives, list):
        return False
    return any(
        isinstance(narrative, dict)
        and narrative.get("verdict") in {"confirmed-vulnerability", "confirmed-defect"}
        for narrative in narratives
    )


__all__ = [
    "PullRequestReviewWorkflow",
    "analyze_pull_request_activity",
    "archive_pull_request_feedback_attempt_activity",
    "build_pull_request_review_result_activity",
    "mitigate_pull_request_activity",
    "verify_pull_request_activity",
]
