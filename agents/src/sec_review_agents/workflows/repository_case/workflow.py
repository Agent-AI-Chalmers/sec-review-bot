"""Temporal orchestration and activities for one prepared repository case."""

import asyncio
from datetime import timedelta
from pathlib import Path
from typing import Any, TypedDict

from temporalio import activity, workflow

from sec_review_agents.review_stages.analysis.result import AnalysisStageResult
from sec_review_agents.review_stages.cvss.result import CvssStageResult
from sec_review_agents.review_stages.feedback_loop import (
    MAX_FEEDBACK_RETRY_ATTEMPTS,
    FeedbackRetryContext,
    VerifierHistoryEntry,
    feedback_retry_context,
    should_retry_from_verifier_result,
)
from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from sec_review_agents.review_stages.record import build_review_record
from sec_review_agents.review_stages.repair_target import has_confirmed_repair_target
from sec_review_agents.review_stages.verification.result import VerificationStageResult
from sec_review_agents.runtime.runtime_config import ExecutionRuntimeContext
from sec_review_agents.temporal.support import (
    activity_retry_policy,
)
from sec_review_agents.workflows.repository_case.input import (
    PreparedRepositoryCase,
    RepositoryCaseExecutionInput,
)


class RepositoryCaseReviewRequest(TypedDict):
    run_id: str
    case_execution_input: RepositoryCaseExecutionInput
    cases_artifacts_path: str
    published_trajectories_path: str
    timeout_seconds: int
    runtime_context: ExecutionRuntimeContext


def _repository_case_id_from_request(
    case_request: RepositoryCaseReviewRequest,
) -> str:
    return case_request["case_execution_input"]["case_id"].strip()


def _repository_case_review_timeout_seconds(
    request: RepositoryCaseReviewRequest,
) -> int:
    timeout_seconds = request.get("timeout_seconds")
    if (
        not isinstance(timeout_seconds, int)
        or isinstance(timeout_seconds, bool)
        or timeout_seconds < 1
    ):
        raise ValueError("Repository case activity timeout must be a positive integer.")
    return timeout_seconds


def _repository_case_trajectory_path(
    prepared_case: PreparedRepositoryCase,
    *,
    order: int,
    stage: str,
    attempt: str = "initial",
) -> Path:
    from sec_review_agents.review_stages.trajectories import (
        review_trajectory_path,
    )

    published_root = Path(prepared_case["published_trajectories_path"])
    return review_trajectory_path(
        published_root,
        order=order,
        stage=stage,
        attempt=attempt,
    )


@activity.defn
def prepare_repository_case_activity(
    request: RepositoryCaseReviewRequest,
) -> PreparedRepositoryCase:
    from sec_review_agents.workflows.repository_case.stage import (
        repository_case_stage_artifact_paths,
    )

    case_execution_input = request["case_execution_input"]
    case_id = case_execution_input.get("case_id")
    if not isinstance(case_id, str) or not case_id.strip():
        raise ValueError("Repository case execution input is missing case_id.")
    review_input = case_execution_input.get("review_input")
    if not isinstance(review_input, str) or not review_input.strip():
        raise ValueError(
            f"Repository case execution input for {case_id} is missing review_input."
        )
    for key in ("cases_artifacts_path", "published_trajectories_path"):
        value = request.get(key)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"Repository case request is missing valid {key}.")
    # Validate once before fan-out; stages consume this normalized serialized input.
    for key in ("workspace_snapshot_tar_path", "history_path"):
        value = case_execution_input.get(key)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"Repository case execution input is missing valid {key}.")
    if case_execution_input.get("test_changes") not in ("allow", "deny"):
        raise ValueError(
            "Repository case execution input is missing valid test_changes."
        )
    if case_execution_input.get("scan_mode") not in ("full", "incremental"):
        raise ValueError("Repository case execution input is missing valid scan_mode.")
    case_execution_input = case_execution_input.copy()
    for key in ("incremental_window_path", "setup_declaration_content"):
        value = case_execution_input.get(key)
        if value is not None and not isinstance(value, str):
            raise ValueError(f"Repository case execution input has invalid {key}.")
    window = case_execution_input.get("incremental_window_path")
    case_execution_input["incremental_window_path"] = (
        window if window is not None and window.strip() else None
    )
    content = case_execution_input.get("setup_declaration_content")
    if content is not None and not content.strip():
        case_execution_input["setup_declaration_content"] = None
    return {
        "case_execution_input": case_execution_input,
        "artifact_paths": repository_case_stage_artifact_paths(
            cases_artifacts_path=Path(request["cases_artifacts_path"]),
            case_id=case_id.strip(),
        ),
        "published_trajectories_path": request["published_trajectories_path"],
    }


@activity.defn
async def analyze_repository_case_activity(
    request: RepositoryCaseReviewRequest,
    prepared_case: PreparedRepositoryCase,
) -> AnalysisStageResult:
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.temporal.support import activity_trace_labels
    from sec_review_agents.workflows.repository_case.stage import (
        analyze_repository_case_stage,
    )

    with bind_trace_context(
        **activity_trace_labels(
            workflow_name="repository-review",
            run_id=request["run_id"],
            case_id=_repository_case_id_from_request(request),
            pass_kind="initial",
            pass_index="0",
        )
    ):
        return await analyze_repository_case_stage(
            prepared_case["case_execution_input"],
            analyzer_artifacts_path=Path(prepared_case["artifact_paths"]["analyzer"]),
            published_trajectory_path=_repository_case_trajectory_path(
                prepared_case,
                order=1,
                stage="analyzer",
            ),
            runtime_context=request["runtime_context"],
        )


@activity.defn
async def score_repository_case_cvss_activity(
    request: RepositoryCaseReviewRequest,
    prepared_case: PreparedRepositoryCase,
    analysis_result: AnalysisStageResult,
) -> CvssStageResult:
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.temporal.support import activity_trace_labels
    from sec_review_agents.workflows.repository_case.stage import (
        score_repository_case_cvss_stage,
    )

    with bind_trace_context(
        **activity_trace_labels(
            workflow_name="repository-review",
            run_id=request["run_id"],
            case_id=_repository_case_id_from_request(request),
            pass_kind="initial",
            pass_index="0",
        )
    ):
        return await score_repository_case_cvss_stage(
            prepared_case["case_execution_input"],
            analysis_result,
            cvss_artifacts_path=Path(prepared_case["artifact_paths"]["cvss"]),
        )


@activity.defn
async def mitigate_repository_case_activity(
    request: RepositoryCaseReviewRequest,
    prepared_case: PreparedRepositoryCase,
    analysis_result: AnalysisStageResult,
    retry_context: FeedbackRetryContext | None,
) -> MitigationStageResult:
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.review_stages.feedback_loop import review_stage_attempt_order
    from sec_review_agents.review_stages.mitigation.stage import (
        create_skipped_mitigation_result,
        mitigation_attempt_label,
    )
    from sec_review_agents.temporal.support import activity_trace_labels
    from sec_review_agents.workflows.repository_case.stage import (
        MITIGATION_NO_TARGET_REASON,
        run_repository_case_mitigation_stage,
    )

    mitigator_artifacts_path = Path(prepared_case["artifact_paths"]["mitigator"])
    if not has_confirmed_repair_target(analysis_result):
        _repository_case_trajectory_path(
            prepared_case,
            order=review_stage_attempt_order(
                stage="mitigator", retry_context=retry_context
            ),
            stage="mitigator",
            attempt=mitigation_attempt_label(retry_context),
        ).unlink(missing_ok=True)
        return create_skipped_mitigation_result(
            mitigator_artifacts_path=mitigator_artifacts_path,
            retry_context=retry_context,
            reason=MITIGATION_NO_TARGET_REASON,
        )
    pass_index = retry_context.retry_index if retry_context is not None else 0
    with bind_trace_context(
        **activity_trace_labels(
            workflow_name="repository-review",
            run_id=request["run_id"],
            case_id=_repository_case_id_from_request(request),
            pass_kind="feedback" if retry_context is not None else "initial",
            pass_index=str(pass_index),
        )
    ):
        return await run_repository_case_mitigation_stage(
            prepared_case["case_execution_input"],
            analysis_result,
            retry_context,
            request["runtime_context"],
            mitigator_artifacts_path=mitigator_artifacts_path,
            published_trajectory_path=_repository_case_trajectory_path(
                prepared_case,
                order=review_stage_attempt_order(
                    stage="mitigator", retry_context=retry_context
                ),
                stage="mitigator",
                attempt=mitigation_attempt_label(retry_context),
            ),
        )


@activity.defn
async def verify_repository_case_activity(
    request: RepositoryCaseReviewRequest,
    prepared_case: PreparedRepositoryCase,
    analysis_result: AnalysisStageResult,
    mitigation_result: MitigationStageResult | None,
    retry_context: FeedbackRetryContext | None,
) -> VerificationStageResult:
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.review_stages.feedback_loop import review_stage_attempt_order
    from sec_review_agents.review_stages.verification.stage import (
        create_skipped_verification_result,
        verification_attempt_label,
    )
    from sec_review_agents.temporal.support import activity_trace_labels
    from sec_review_agents.workflows.repository_case.stage import (
        run_repository_case_verification_stage,
    )

    verifier_artifacts_path = Path(prepared_case["artifact_paths"]["verifier"])
    if not has_confirmed_repair_target(analysis_result):
        _repository_case_trajectory_path(
            prepared_case,
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
    pass_index = retry_context.retry_index if retry_context is not None else 0
    with bind_trace_context(
        **activity_trace_labels(
            workflow_name="repository-review",
            run_id=request["run_id"],
            case_id=_repository_case_id_from_request(request),
            pass_kind="feedback" if retry_context is not None else "initial",
            pass_index=str(pass_index),
        )
    ):
        return await run_repository_case_verification_stage(
            prepared_case["case_execution_input"],
            analysis_result,
            mitigation_result,
            retry_context,
            request["runtime_context"],
            verifier_artifacts_path=verifier_artifacts_path,
            published_trajectory_path=_repository_case_trajectory_path(
                prepared_case,
                order=review_stage_attempt_order(
                    stage="verifier", retry_context=retry_context
                ),
                stage="verifier",
                attempt=verification_attempt_label(retry_context),
            ),
        )


@activity.defn
def archive_repository_case_feedback_attempt_activity(
    prepared_case: PreparedRepositoryCase,
    retry_context: FeedbackRetryContext,
) -> None:
    from sec_review_agents.review_stages.feedback_loop import (
        archive_initial_feedback_attempt,
    )

    archive_initial_feedback_attempt(
        mitigator_root=Path(prepared_case["artifact_paths"]["mitigator"]),
        verifier_root=Path(prepared_case["artifact_paths"]["verifier"]),
        retry_context=retry_context,
    )


@activity.defn
def build_repository_case_result_activity(
    prepared_case: PreparedRepositoryCase,
    analysis_result: AnalysisStageResult,
    cvss_result: CvssStageResult | None,
    mitigation_result: MitigationStageResult | None,
    verifier_result: VerificationStageResult | None,
) -> dict[str, Any]:
    from sec_review_agents.workflows.repository_case.stage import (
        derive_case_disposition,
    )

    case_execution_input = prepared_case["case_execution_input"]
    case_id = case_execution_input["case_id"].strip()
    case_disposition = derive_case_disposition(
        analysis_result,
        mitigation_result,
        verifier_result,
    )
    return {
        "case_id": case_id,
        "disposition": case_disposition["disposition"],
        "reason": case_disposition.get("reason"),
        "review_record": build_review_record(
            analysis_result=analysis_result,
            mitigation_result=mitigation_result,
            verifier_result=verifier_result,
            cvss_result=cvss_result,
        ).model_dump(mode="json", by_alias=True),
    }


@workflow.defn
class RepositoryCaseReviewWorkflow:
    @workflow.run
    async def run(self, request: RepositoryCaseReviewRequest) -> dict[str, Any]:
        activity_timeout = timedelta(
            seconds=_repository_case_review_timeout_seconds(request)
        )
        retry_policy = activity_retry_policy()
        prepared_case: PreparedRepositoryCase = await workflow.execute_activity(
            prepare_repository_case_activity,
            args=[request],
            schedule_to_close_timeout=activity_timeout,
            retry_policy=retry_policy,
        )
        analysis_result = await workflow.execute_activity(
            analyze_repository_case_activity,
            args=[request, prepared_case],
            schedule_to_close_timeout=activity_timeout,
            retry_policy=retry_policy,
        )
        # CVSS only depends on the analyzer result, so it can run while
        # mitigation works on the same case.
        cvss_task = asyncio.create_task(
            workflow.execute_activity(
                score_repository_case_cvss_activity,
                args=[request, prepared_case, analysis_result],
                schedule_to_close_timeout=activity_timeout,
                retry_policy=retry_policy,
            )
        )
        try:
            mitigation_result = await workflow.execute_activity(
                mitigate_repository_case_activity,
                args=[request, prepared_case, analysis_result, None],
                schedule_to_close_timeout=activity_timeout,
                retry_policy=retry_policy,
            )
            verifier_result = await workflow.execute_activity(
                verify_repository_case_activity,
                args=[
                    request,
                    prepared_case,
                    analysis_result,
                    mitigation_result,
                    None,
                ],
                schedule_to_close_timeout=activity_timeout,
                retry_policy=retry_policy,
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
                    archive_repository_case_feedback_attempt_activity,
                    args=[prepared_case, retry_context],
                    schedule_to_close_timeout=activity_timeout,
                    retry_policy=retry_policy,
                )
                mitigation_result = await workflow.execute_activity(
                    mitigate_repository_case_activity,
                    args=[
                        request,
                        prepared_case,
                        analysis_result,
                        retry_context,
                    ],
                    schedule_to_close_timeout=activity_timeout,
                    retry_policy=retry_policy,
                )
                verifier_result = await workflow.execute_activity(
                    verify_repository_case_activity,
                    args=[
                        request,
                        prepared_case,
                        analysis_result,
                        mitigation_result,
                        retry_context,
                    ],
                    schedule_to_close_timeout=activity_timeout,
                    retry_policy=retry_policy,
                )
            # CVSS is advisory. Scoring failures observed by the activity are
            # persisted there; Temporal remains the record for infrastructure
            # failures that happen outside the activity execution.
            try:
                cvss_result = await cvss_task
            except Exception:
                cvss_result = None
        except Exception:
            if not cvss_task.done():
                cvss_task.cancel()
            try:
                await cvss_task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
            raise
        result = await workflow.execute_activity(
            build_repository_case_result_activity,
            args=[
                prepared_case,
                analysis_result,
                cvss_result,
                mitigation_result,
                verifier_result,
            ],
            schedule_to_close_timeout=activity_timeout,
            retry_policy=retry_policy,
        )
        return result
