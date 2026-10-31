from datetime import timedelta
from typing import Any

from temporalio import activity, workflow

from sec_review_agents.contract_versions import EXECUTION_API_VERSION
from sec_review_agents.review_stages.analysis.result import AnalysisStageResult
from sec_review_agents.review_stages.feedback_loop import (
    MAX_FEEDBACK_RETRY_ATTEMPTS,
    FeedbackRetryContext,
    VerifierHistoryEntry,
    feedback_retry_context,
    should_retry_from_verifier_result,
)
from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from sec_review_agents.review_stages.repair_target import has_confirmed_repair_target
from sec_review_agents.review_stages.verification.result import VerificationStageResult
from sec_review_agents.run_diagnostics.publication import (
    RunDiagnosticPublicationRequest,
    publish_run_diagnostic_activity,
)
from sec_review_agents.temporal.support import (
    activity_retry_policy,
)
from sec_review_agents.utils.paths import required_path
from sec_review_agents.workflows.memory.scheduling import schedule_memory_extractions
from sec_review_agents.workflows.review_intent import (
    REVIEW_OBJECTIVE_AUDIT,
    require_review_intent,
)
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest


@activity.defn
async def analyze_pull_request_activity(
    request: ReviewWorkflowRequest,
) -> AnalysisStageResult:
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.review_stages.trajectories import (
        review_trajectories_root,
        review_trajectory_path,
    )
    from sec_review_agents.runtime.setup_bootstrap import (
        setup_declaration_content_for_backend,
    )
    from sec_review_agents.temporal.support import activity_trace_labels
    from sec_review_agents.utils.paths import (
        artifact_path,
        required_path,
    )
    from sec_review_agents.workflows.pull_request.analysis import (
        analyze_pull_request,
    )

    prepared_input = request.prepared_input
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
    with bind_trace_context(
        **activity_trace_labels(
            workflow_name=request.workflow,
            run_id=request.run_id,
            pass_kind="initial",
            pass_index="0",
        )
    ):
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
            published_trajectory_path=review_trajectory_path(
                review_trajectories_root(run_artifacts_root),
                order=1,
                stage="analyzer",
            ),
            setup_declaration_content=setup_declaration_content_for_backend(
                prepared_input
            ),
            runtime_context=request.runtime_context,
        )


@activity.defn
async def mitigate_pull_request_activity(
    request: ReviewWorkflowRequest,
    analysis_result: AnalysisStageResult,
    retry_context: FeedbackRetryContext | None,
) -> MitigationStageResult:
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.review_stages.feedback_loop import review_stage_attempt_order
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
    from sec_review_agents.utils.paths import (
        artifact_path,
        required_path,
    )
    from sec_review_agents.workflows.pull_request.mitigation import (
        mitigate_pull_request,
    )

    prepared_input = request.prepared_input
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
    if not has_confirmed_repair_target(analysis_result):
        review_trajectory_path(
            review_trajectories_root(run_artifacts_root),
            order=review_stage_attempt_order(
                stage="mitigator", retry_context=retry_context
            ),
            stage="mitigator",
            attempt=mitigation_attempt_label(retry_context),
        ).unlink(missing_ok=True)
        return create_skipped_mitigation_result(
            mitigator_artifacts_path=mitigator_artifacts_path,
            retry_context=retry_context,
            reason="No confirmed, reparable mitigation target was available from the analyzer output.",
        )
    bundle_paths = prepared_input["bundle_paths"]
    pass_index = retry_context.retry_index if retry_context is not None else 0
    with bind_trace_context(
        **activity_trace_labels(
            workflow_name=request.workflow,
            run_id=request.run_id,
            pass_kind="feedback" if retry_context is not None else "initial",
            pass_index=str(pass_index),
        )
    ):
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
            published_trajectory_path=review_trajectory_path(
                review_trajectories_root(run_artifacts_root),
                order=review_stage_attempt_order(
                    stage="mitigator", retry_context=retry_context
                ),
                stage="mitigator",
                attempt=mitigation_attempt_label(retry_context),
            ),
            analysis_result=analysis_result,
            retry_context=retry_context,
            test_changes=review_intent.test_changes,
            setup_declaration_content=setup_declaration_content_for_backend(
                prepared_input
            ),
            runtime_context=request.runtime_context,
        )


@activity.defn
async def verify_pull_request_activity(
    request: ReviewWorkflowRequest,
    analysis_result: AnalysisStageResult,
    mitigation_result: MitigationStageResult | None,
    retry_context: FeedbackRetryContext | None,
) -> VerificationStageResult:
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.review_stages.feedback_loop import review_stage_attempt_order
    from sec_review_agents.review_stages.trajectories import (
        review_trajectories_root,
        review_trajectory_path,
    )
    from sec_review_agents.review_stages.verification.stage import (
        create_skipped_verification_result,
        verification_attempt_label,
    )
    from sec_review_agents.runtime.setup_bootstrap import (
        setup_declaration_content_for_backend,
    )
    from sec_review_agents.temporal.support import activity_trace_labels
    from sec_review_agents.utils.paths import (
        artifact_path,
        required_path,
    )
    from sec_review_agents.workflows.pull_request.verification import (
        verify_pull_request,
    )

    prepared_input = request.prepared_input
    run_artifacts_root = required_path(
        prepared_input["artifact_root_path"],
        label="artifact_root_path",
    )
    verifier_artifacts_path = artifact_path(
        prepared_input["artifact_paths"],
        "verifier",
    )
    if not has_confirmed_repair_target(analysis_result):
        review_trajectory_path(
            review_trajectories_root(run_artifacts_root),
            order=review_stage_attempt_order(
                stage="verifier", retry_context=retry_context
            ),
            stage="verifier",
            attempt=verification_attempt_label(retry_context),
        ).unlink(missing_ok=True)
        return create_skipped_verification_result(
            verifier_artifacts_path=verifier_artifacts_path,
            retry_context=retry_context,
            reason="Verification was skipped because analysis produced no confirmed repair target.",
        )
    bundle_paths = prepared_input["bundle_paths"]
    workspace_snapshot_tar_path = required_path(
        bundle_paths["workspace_snapshot_tar_path"],
        label="bundle_paths.workspace_snapshot_tar_path",
    )
    pass_index = retry_context.retry_index if retry_context is not None else 0
    with bind_trace_context(
        **activity_trace_labels(
            workflow_name=request.workflow,
            run_id=request.run_id,
            pass_kind="feedback" if retry_context is not None else "initial",
            pass_index=str(pass_index),
        )
    ):
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
            verifier_artifacts_path=verifier_artifacts_path,
            published_trajectory_path=review_trajectory_path(
                review_trajectories_root(run_artifacts_root),
                order=review_stage_attempt_order(
                    stage="verifier", retry_context=retry_context
                ),
                stage="verifier",
                attempt=verification_attempt_label(retry_context),
            ),
            analysis_result=analysis_result,
            mitigation_result=mitigation_result,
            retry_context=retry_context,
            setup_declaration_content=setup_declaration_content_for_backend(
                prepared_input
            ),
            runtime_context=request.runtime_context,
        )


@activity.defn
def archive_pull_request_feedback_attempt_activity(
    prepared_input: dict[str, Any],
    retry_context: FeedbackRetryContext,
) -> None:
    from sec_review_agents.review_stages.feedback_loop import (
        archive_initial_feedback_attempt,
    )
    from sec_review_agents.utils.paths import artifact_path

    archive_initial_feedback_attempt(
        mitigator_root=artifact_path(prepared_input["artifact_paths"], "mitigator"),
        verifier_root=artifact_path(prepared_input["artifact_paths"], "verifier"),
        retry_context=retry_context,
    )


@activity.defn
def build_pull_request_review_result_activity(
    analysis_result: AnalysisStageResult,
    mitigation_result: MitigationStageResult | None,
    verifier_result: VerificationStageResult | None,
) -> dict[str, Any]:
    from sec_review_agents.review_stages.record import build_review_record

    return {
        "api_version": EXECUTION_API_VERSION,
        "review_record": build_review_record(
            analysis_result=analysis_result,
            mitigation_result=mitigation_result,
            verifier_result=verifier_result,
            cvss_result=None,
        ).model_dump(mode="json", by_alias=True),
    }


@workflow.defn
class PullRequestReviewWorkflow:
    @workflow.run
    async def run(self, request: ReviewWorkflowRequest) -> dict[str, Any]:
        analysis_result = await workflow.execute_activity(
            analyze_pull_request_activity,
            request,
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        mitigation_result = await workflow.execute_activity(
            mitigate_pull_request_activity,
            args=[request, analysis_result, None],
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        verifier_result = await workflow.execute_activity(
            verify_pull_request_activity,
            args=[
                request,
                analysis_result,
                mitigation_result,
                None,
            ],
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        retry_count = 0
        history: list[VerifierHistoryEntry] = []
        while (
            retry_count < MAX_FEEDBACK_RETRY_ATTEMPTS
            and should_retry_from_verifier_result(verifier_result)
        ):
            retry_count += 1
            retry_context = feedback_retry_context(
                retry_index=retry_count,
                mitigation_result=mitigation_result,
                verifier_result=verifier_result,
                history=history,
            )
            history = retry_context.history
            await workflow.execute_activity(
                archive_pull_request_feedback_attempt_activity,
                args=[request.prepared_input, retry_context],
                schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
                retry_policy=activity_retry_policy(),
            )
            mitigation_result = await workflow.execute_activity(
                mitigate_pull_request_activity,
                args=[request, analysis_result, retry_context],
                schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
                retry_policy=activity_retry_policy(),
            )
            verifier_result = await workflow.execute_activity(
                verify_pull_request_activity,
                args=[
                    request,
                    analysis_result,
                    mitigation_result,
                    retry_context,
                ],
                schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
                retry_policy=activity_retry_policy(),
            )
        result = await workflow.execute_activity(
            build_pull_request_review_result_activity,
            args=[analysis_result, mitigation_result, verifier_result],
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        artifact_root = required_path(
            request.prepared_input.get("artifact_root_path"),
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
                    result=result,
                    destination_scheme=request.post_processing.diagnostic_scheme,
                )
            ],
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        memory_processing = await schedule_memory_extractions(
            source_workflow=request.workflow,
            run_id=request.run_id,
            diagnostic_bundle=dict(finalized["diagnostic_bundle"]),
            unit_ids=[str(value) for value in finalized["unit_ids"]],
            timeout_seconds=request.timeout_seconds,
            enabled=request.post_processing.memory_processing_enabled,
        )
        return {
            "ok": True,
            "result": result,
            "memory_processing": memory_processing,
            "artifact_storage": finalized["artifact_storage"],
        }


__all__ = [
    "PullRequestReviewWorkflow",
    "analyze_pull_request_activity",
    "archive_pull_request_feedback_attempt_activity",
    "build_pull_request_review_result_activity",
    "mitigate_pull_request_activity",
    "verify_pull_request_activity",
]
