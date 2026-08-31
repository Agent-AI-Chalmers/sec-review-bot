import asyncio
import os
from collections.abc import Mapping, Sequence
from datetime import timedelta
from pathlib import Path
from typing import Any, TypedDict

from temporalio import activity, workflow

from sec_review_agents.delivery_stages.model import DeliveryCaseInput
from sec_review_agents.memory.extraction_workflow import (
    register_memory_extraction_for_review,
)
from sec_review_agents.review_stages.feedback_loop import (
    MAX_FEEDBACK_RETRY_ATTEMPTS,
    feedback_retry_context,
    should_retry_from_verifier_result,
)
from sec_review_agents.review_stages.record import build_review_record
from sec_review_agents.runtime.runtime_config import RunnerRuntimeContext
from sec_review_agents.scan_stages.discovery.result import DiscoveryResult
from sec_review_agents.scan_stages.triage.result import TriageResult
from sec_review_agents.temporal.support import (
    activity_retry_policy,
    execute_activity,
    prepare_internal_workflow_activity,
)
from sec_review_agents.workflows.execution_request import InternalWorkflowRequest
from sec_review_agents.workflows.repository.case_execution_input import (
    RepositoryCaseExecutionInput,
)
from sec_review_agents.workflows.review_intent import (
    REVIEW_OBJECTIVE_AUDIT,
    require_review_intent,
)

DEFAULT_CASE_PROCESSING_MAX_CONCURRENCY = 1


class RepositoryCaseReviewRequest(TypedDict):
    run_id: str
    case_execution_input: RepositoryCaseExecutionInput
    cases_artifacts_path: str
    transcript_thread_path: str
    timeout_seconds: int
    runtime_context: RunnerRuntimeContext


class RepositoryCaseRequestBatch(TypedDict):
    max_concurrency: int
    case_requests: list[RepositoryCaseReviewRequest]


def _repository_case_id_from_request(
    case_request: RepositoryCaseReviewRequest,
) -> str:
    return case_request["case_execution_input"]["case_id"].strip()


def build_blocked_repository_case_result(
    case_request: RepositoryCaseReviewRequest,
    reason: str,
) -> dict[str, Any]:
    return {
        "case_id": _repository_case_id_from_request(case_request),
        "disposition": "blocked",
        "reason": reason,
        "review_record": build_review_record(
            analysis_result=None,
            mitigation_result=None,
            verifier_result=None,
            cvss_result=None,
        ),
    }


def _stage_error_message(error: Exception) -> str:
    return f"{type(error).__name__}: {error}"


def _repository_case_timeout_seconds(
    request: InternalWorkflowRequest,
) -> int:
    timeout_seconds = request.timeout_seconds
    if (
        not isinstance(timeout_seconds, int)
        or isinstance(timeout_seconds, bool)
        or timeout_seconds < 1
    ):
        raise ValueError("Repository case activity timeout must be a positive integer.")
    return timeout_seconds


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


# Repository cases publish transcripts into case-specific threads, not the
# default review thread used by issue and PR workflows.
def _repository_case_published_transcript_path(
    prepared_case: dict[str, Any],
    *,
    order: int,
    stage: str,
    attempt: str = "initial",
) -> Path:
    from sec_review_agents.run_artifacts.transcripts import transcript_thread_file
    from sec_review_agents.utils.paths import required_path

    return transcript_thread_file(
        required_path(
            prepared_case.get("transcript_thread_path"),
            label="transcript_thread_path",
        ),
        order=order,
        stage=stage,
        attempt=attempt,
    )


def resolve_repository_case_processing_max_concurrency(case_count: int) -> int:
    from sec_review_agents.utils.env import parse_int_env

    if case_count <= 0:
        return 1
    configured = (
        parse_int_env(
            os.environ.get("AGENT_CASE_PROCESSING_MAX_CONCURRENCY"),
            DEFAULT_CASE_PROCESSING_MAX_CONCURRENCY,
        )
        or DEFAULT_CASE_PROCESSING_MAX_CONCURRENCY
    )
    return max(1, min(case_count, configured))


@activity.defn
def build_repository_discovery_manifest_activity(
    request: InternalWorkflowRequest,
) -> dict[str, Any]:
    from sec_review_agents.scan_stages.discovery.stage import (
        prepare_discovery_chunks,
    )
    from sec_review_agents.utils.paths import artifact_path, required_path
    from sec_review_agents.workspace.snapshots import (
        ARTIFACT_WORKSPACE_DIR_NAME,
        restore_workspace_from_snapshot_tar,
    )

    review_intent = require_review_intent(request.prepared_input.get("review_intent"))
    if review_intent.objective != REVIEW_OBJECTIVE_AUDIT:
        raise ValueError("review_intent.objective must be 'audit'.")
    prepared_input = request.prepared_input
    run_artifacts_root = required_path(
        prepared_input["artifact_root_path"],
        label="artifact_root_path",
    )
    bundle_paths = prepared_input["bundle_paths"]
    workspace_snapshot_tar_path = required_path(
        bundle_paths["workspace_snapshot_tar_path"],
        label="bundle_paths.workspace_snapshot_tar_path",
    )
    workspace_root = restore_workspace_from_snapshot_tar(
        tar_path=workspace_snapshot_tar_path,
        destination_path=run_artifacts_root / ARTIFACT_WORKSPACE_DIR_NAME,
    )
    discovery_artifacts_path = artifact_path(
        prepared_input["artifact_paths"],
        "discovery",
    )
    return prepare_discovery_chunks(
        workspace_root=workspace_root,
        scan_mode=str(prepared_input["scan_target"]["scan_mode"]),
        scan_scope=prepared_input["scan_scope"],
        discovery_artifacts_path=discovery_artifacts_path,
    )


@activity.defn
async def scan_repository_discovery_chunk_activity(
    manifest: Mapping[str, Any],
    chunk: Mapping[str, Any],
) -> dict[str, Any]:
    from pathlib import Path

    from sec_review_agents.scan_stages.discovery.stage import scan_discovery_chunk

    return await scan_discovery_chunk(
        chunk=chunk,
        root=Path(manifest["workspace_root"]),
        discovery_artifacts_path=Path(str(manifest["discovery_artifacts_path"])),
    )


@activity.defn
def build_repository_discovery_result_activity(
    manifest: Mapping[str, Any],
    chunk_results: Sequence[Mapping[str, Any]],
) -> DiscoveryResult:
    from sec_review_agents.scan_stages.discovery.stage import (
        build_discovery_result_from_chunks,
    )

    return build_discovery_result_from_chunks(
        entries=list(manifest["entries"]),
        skipped_files=list(manifest["skipped_files"]),
        chunks=list(manifest["chunks"]),
        chunk_results=chunk_results,
        scan_mode=str(manifest["scan_mode"]),
        chunk_target_tokens=int(manifest["chunk_target_tokens"]),
        discovery_artifacts_path=Path(str(manifest["discovery_artifacts_path"])),
    )


@activity.defn
async def triage_repository_activity(
    request: InternalWorkflowRequest,
    discovery_result: Mapping[str, Any],
) -> TriageResult:
    from sec_review_agents.scan_stages.triage.stage import run_repository_triage_stage
    from sec_review_agents.utils.paths import artifact_path

    return await run_repository_triage_stage(
        triage_root=artifact_path(request.prepared_input["artifact_paths"], "triage"),
        discovery_result=discovery_result,
    )


@activity.defn
def prepare_repository_case_review_inputs_activity(
    request: InternalWorkflowRequest,
    cases: Sequence[Mapping[str, Any]],
) -> RepositoryCaseRequestBatch:
    from sec_review_agents.run_artifacts.transcripts import (
        repository_case_thread_name,
        review_thread_dir,
    )
    from sec_review_agents.utils.paths import artifact_path, required_path
    from sec_review_agents.workflows.repository.case_execution_input import (
        prepare_case_execution_input,
    )

    prepared_input = request.prepared_input
    run_artifacts_root = required_path(
        prepared_input["artifact_root_path"],
        label="artifact_root_path",
    )
    bundle_paths = prepared_input["bundle_paths"]
    workspace_snapshot_tar_path = required_path(
        bundle_paths["workspace_snapshot_tar_path"],
        label="bundle_paths.workspace_snapshot_tar_path",
    )
    history_path = required_path(
        bundle_paths["history_path"],
        label="bundle_paths.history_path",
    )
    incremental_window_path = (
        required_path(
            bundle_paths.get("incremental_window_path"),
            label="bundle_paths.incremental_window_path",
        )
        if isinstance(bundle_paths.get("incremental_window_path"), str)
        else None
    )
    cases_artifacts_path = artifact_path(prepared_input["artifact_paths"], "cases")
    scan_mode = str(prepared_input["scan_target"]["scan_mode"])
    review_intent = require_review_intent(prepared_input.get("review_intent"))
    timeout_seconds = _repository_case_timeout_seconds(request)
    return {
        "max_concurrency": resolve_repository_case_processing_max_concurrency(
            len(cases)
        ),
        "case_requests": [
            {
                "run_id": request.run_id,
                "case_execution_input": prepare_case_execution_input(
                    workspace_snapshot_tar_path=workspace_snapshot_tar_path,
                    history_path=history_path,
                    incremental_window_path=incremental_window_path,
                    scan_mode=scan_mode,
                    case=case,
                    repair_mode=review_intent.repair_mode,
                ),
                "cases_artifacts_path": str(cases_artifacts_path),
                "transcript_thread_path": str(
                    review_thread_dir(
                        run_artifacts_root,
                        thread_name=repository_case_thread_name(
                            case_id=str(case.get("case_id") or index),
                            index=index,
                        ),
                    )
                ),
                "timeout_seconds": timeout_seconds,
                "runtime_context": request.runtime_context,
            }
            for index, case in enumerate(cases, start=1)
        ],
    }


@activity.defn
def prepare_repository_case_activity(
    request: RepositoryCaseReviewRequest,
) -> dict[str, Any]:
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
    return {
        "case_execution_input": case_execution_input,
        "artifact_paths": repository_case_stage_artifact_paths(
            cases_artifacts_path=Path(request["cases_artifacts_path"]),
            case_id=case_id.strip(),
        ),
        "transcript_thread_path": request["transcript_thread_path"],
    }


@activity.defn
async def analyze_repository_case_activity(
    prepared_case: dict[str, Any],
    runtime_context: RunnerRuntimeContext,
) -> dict[str, Any]:
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.utils.paths import artifact_path
    from sec_review_agents.workflows.repository_case.stage import (
        analyze_repository_case_stage,
    )

    bind_trace_context(workflow="repository-review")
    return await analyze_repository_case_stage(
        prepared_case["case_execution_input"],
        analyzer_artifacts_path=artifact_path(
            prepared_case["artifact_paths"],
            "analyzer",
        ),
        published_transcript_path=_repository_case_published_transcript_path(
            prepared_case,
            order=1,
            stage="analyzer",
        ),
        runtime_context=runtime_context,
    )


@activity.defn
async def score_repository_case_cvss_activity(
    prepared_case: dict[str, Any],
    analysis_result: Mapping[str, Any],
) -> dict[str, Any]:
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.utils.paths import artifact_path
    from sec_review_agents.workflows.repository_case.stage import (
        score_repository_case_cvss_stage,
    )

    bind_trace_context(workflow="repository-review")
    return await score_repository_case_cvss_stage(
        prepared_case["case_execution_input"],
        analysis_result,
        cvss_artifacts_path=artifact_path(
            prepared_case["artifact_paths"],
            "cvss",
        ),
    )


@activity.defn
def build_failed_repository_case_cvss_result_activity(
    prepared_case: dict[str, Any],
    error: str,
) -> None:
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.review_stages.cvss.stage import (
        persist_failed_cvss_v4_result,
    )
    from sec_review_agents.utils.paths import artifact_path

    bind_trace_context(workflow="repository-review")
    return persist_failed_cvss_v4_result(
        cvss_artifacts_path=artifact_path(
            prepared_case["artifact_paths"],
            "cvss",
        ),
        error=error,
    )


@activity.defn
async def mitigate_repository_case_activity(
    prepared_case: dict[str, Any],
    analysis_result: Mapping[str, Any],
    retry_context: Mapping[str, Any] | None,
    runtime_context: RunnerRuntimeContext,
) -> dict[str, Any]:
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.review_stages.mitigation.stage import (
        create_skipped_mitigation_result,
        mitigation_attempt_label,
    )
    from sec_review_agents.run_artifacts.transcripts import retry_stage_order
    from sec_review_agents.utils.paths import artifact_path
    from sec_review_agents.workflows.repository_case.stage import (
        MITIGATION_NO_TARGET_REASON,
        run_repository_case_mitigation_stage,
        should_run_repository_mitigation,
    )

    bind_trace_context(workflow="repository-review")
    mitigator_artifacts_path = artifact_path(
        prepared_case["artifact_paths"],
        "mitigator",
    )
    if not should_run_repository_mitigation(analysis_result):
        _repository_case_published_transcript_path(
            prepared_case,
            order=retry_stage_order(stage="mitigator", retry_context=retry_context),
            stage="mitigator",
            attempt=mitigation_attempt_label(retry_context),
        ).unlink(missing_ok=True)
        return create_skipped_mitigation_result(
            mitigator_artifacts_path=mitigator_artifacts_path,
            retry_context=retry_context,
            reason=MITIGATION_NO_TARGET_REASON,
        )
    return await run_repository_case_mitigation_stage(
        prepared_case["case_execution_input"],
        analysis_result,
        retry_context,
        runtime_context,
        mitigator_artifacts_path=mitigator_artifacts_path,
        published_transcript_path=_repository_case_published_transcript_path(
            prepared_case,
            order=retry_stage_order(stage="mitigator", retry_context=retry_context),
            stage="mitigator",
            attempt=mitigation_attempt_label(retry_context),
        ),
    )


@activity.defn
async def verify_repository_case_activity(
    prepared_case: dict[str, Any],
    analysis_result: Mapping[str, Any],
    mitigation_result: dict[str, Any] | None,
    retry_context: Mapping[str, Any] | None,
    runtime_context: RunnerRuntimeContext,
) -> dict[str, Any]:
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.review_stages.verification.stage import (
        verification_attempt_label,
    )
    from sec_review_agents.run_artifacts.transcripts import retry_stage_order
    from sec_review_agents.utils.paths import artifact_path
    from sec_review_agents.workflows.repository_case.stage import (
        run_repository_case_verification_stage,
    )

    bind_trace_context(workflow="repository-review")
    return await run_repository_case_verification_stage(
        prepared_case["case_execution_input"],
        analysis_result,
        mitigation_result,
        retry_context,
        runtime_context,
        verifier_artifacts_path=artifact_path(
            prepared_case["artifact_paths"],
            "verifier",
        ),
        published_transcript_path=_repository_case_published_transcript_path(
            prepared_case,
            order=retry_stage_order(stage="verifier", retry_context=retry_context),
            stage="verifier",
            attempt=verification_attempt_label(retry_context),
        ),
    )


@activity.defn
def archive_repository_case_feedback_attempt_activity(
    prepared_case: dict[str, Any],
    retry_context: dict[str, Any],
) -> None:
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.run_artifacts.stage import (
        archive_current_feedback_attempt,
    )
    from sec_review_agents.utils.paths import artifact_path

    bind_trace_context(workflow="repository-review")
    archive_current_feedback_attempt(
        mitigator_root=artifact_path(prepared_case["artifact_paths"], "mitigator"),
        verifier_root=artifact_path(prepared_case["artifact_paths"], "verifier"),
        retry_context=retry_context,
    )


@activity.defn
def build_repository_case_result_activity(
    prepared_case: dict[str, Any],
    analysis_result: Mapping[str, Any],
    cvss_result: dict[str, Any] | None,
    mitigation_result: dict[str, Any] | None,
    verifier_result: dict[str, Any] | None,
) -> dict[str, Any]:
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.review_stages.record import build_review_record
    from sec_review_agents.workflows.repository_case.stage import (
        derive_case_disposition,
    )

    bind_trace_context(workflow="repository-review")
    case_execution_input = prepared_case["case_execution_input"]
    case_id = str(case_execution_input["case_id"]).strip()
    case_disposition = derive_case_disposition(
        analysis_result,
        mitigation_result or {},
        verifier_result or {},
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
        ),
    }


def _keep_repository_case_results(
    case_results: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    return [item for item in case_results if item["disposition"] == "keep"]


def project_repository_case_result_for_delivery(
    case_result: Mapping[str, Any],
) -> DeliveryCaseInput:
    review_record = case_result["review_record"]
    analysis = review_record["analysis"]
    mitigation = review_record["mitigation"]
    verification = review_record["verification"]
    return {
        "case_id": case_result["case_id"],
        "disposition": case_result["disposition"],
        "reason": case_result.get("reason"),
        "analyzer_overview": analysis["overview"],
        "analyzer_verdict": analysis["verdict"],
        "mitigation_overview": mitigation.get("overview") or "",
        "mitigator_changed_files": mitigation.get("changed_files") or [],
        "mitigator_file_changes": mitigation.get("file_changes") or [],
        "mitigator_patch_diff": mitigation.get("patch_diff"),
        "verifier_overview": verification["overview"],
        "verifier_coverage": verification["patch_coverage"],
        "verifier_patch_findings": verification["patch_findings"],
        "verifier_findings": verification["verification_findings"],
        "residual_risks": verification["residual_risks"],
    }


def _delivery_case_inputs(
    case_results: Sequence[Mapping[str, Any]],
) -> list[DeliveryCaseInput]:
    return [
        project_repository_case_result_for_delivery(item)
        for item in _keep_repository_case_results(case_results)
    ]


@activity.defn
async def plan_repository_delivery_activity(
    request: InternalWorkflowRequest,
    case_results: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    from sec_review_agents.delivery_stages.planning import (
        build_skipped_delivery_plan,
        generate_delivery_plan,
    )
    from sec_review_agents.utils.paths import required_path

    prepared_input = request.prepared_input
    run_artifacts_root = required_path(
        prepared_input["artifact_root_path"],
        label="artifact_root_path",
    )
    delivery_case_inputs = _delivery_case_inputs(case_results)
    if not delivery_case_inputs:
        return build_skipped_delivery_plan(
            run_artifacts_root=run_artifacts_root,
            total_case_count=len(case_results),
        )
    return await generate_delivery_plan(
        run_artifacts_root=run_artifacts_root,
        case_results=delivery_case_inputs,
    )


@activity.defn
def prepare_repository_delivery_execution_activity(
    request: InternalWorkflowRequest,
    case_results: Sequence[Mapping[str, Any]],
    delivery_plan: Mapping[str, Any],
) -> dict[str, Any]:

    from sec_review_agents.delivery_stages.execution import (
        build_delivery_execution_input,
        persist_delivery_execution_input,
    )
    from sec_review_agents.utils.paths import required_path

    prepared_input = request.prepared_input
    run_artifacts_root = required_path(
        prepared_input["artifact_root_path"],
        label="artifact_root_path",
    )
    bundle_paths = prepared_input["bundle_paths"]
    workspace_snapshot_tar_path = required_path(
        bundle_paths["workspace_snapshot_tar_path"],
        label="bundle_paths.workspace_snapshot_tar_path",
    )
    keep_case_results = _delivery_case_inputs(case_results)
    deliveries = list(delivery_plan["deliveries"])
    persist_delivery_execution_input(
        run_artifacts_root=run_artifacts_root,
        deliveries=deliveries,
        keep_case_results=keep_case_results,
    )
    return build_delivery_execution_input(
        run_artifacts_root=run_artifacts_root,
        workspace_snapshot_tar_path=workspace_snapshot_tar_path,
        deliveries=deliveries,
        keep_case_results=keep_case_results,
    )


@activity.defn
def build_skipped_repository_delivery_result_activity(
    request: InternalWorkflowRequest,
) -> dict[str, Any]:
    from sec_review_agents.delivery_stages.result import (
        build_skipped_delivery_result,
        persist_delivery_result,
    )
    from sec_review_agents.utils.paths import required_path

    run_artifacts_root = required_path(
        request.prepared_input["artifact_root_path"],
        label="artifact_root_path",
    )
    result = build_skipped_delivery_result()
    persist_delivery_result(run_artifacts_root=run_artifacts_root, result=result)
    return result


@activity.defn
async def execute_repository_single_deliveries_activity(
    delivery_execution: Mapping[str, Any],
) -> list[dict[str, Any]]:
    from pathlib import Path

    from sec_review_agents.delivery_stages.execution import (
        execute_delivery_entry,
    )

    outcomes = []
    for delivery_request in delivery_execution["single_delivery_execution_items"]:
        outcome = await execute_delivery_entry(
            run_artifacts_root=Path(delivery_execution["run_artifacts_root_path"]),
            delivery_entry=delivery_request["delivery"],
            case_results=delivery_request["case_items"],
        )
        if outcome is not None:
            outcomes.append(
                {
                    "index": delivery_request["index"],
                    "outcome": outcome,
                }
            )
    return outcomes


@activity.defn
async def execute_repository_combined_delivery_activity(
    delivery_execution: Mapping[str, Any],
    delivery_request: Mapping[str, Any],
) -> dict[str, Any] | None:
    from pathlib import Path

    from sec_review_agents.delivery_stages.execution import (
        execute_delivery_entry,
    )

    run_artifacts_root = Path(delivery_execution["run_artifacts_root_path"])
    delivery_entry = delivery_request["delivery"]
    return await execute_delivery_entry(
        run_artifacts_root=run_artifacts_root,
        baseline_snapshot_tar_path=Path(
            delivery_execution["workspace_snapshot_tar_path"]
        ),
        delivery_entry=delivery_entry,
        case_results=delivery_request["case_items"],
    )


@activity.defn
def build_repository_delivery_result_activity(
    delivery_execution: Mapping[str, Any],
    patch_outcomes: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    from pathlib import Path

    from sec_review_agents.delivery_stages.result import (
        build_delivery_result_from_outcomes,
        persist_delivery_result,
    )

    run_artifacts_root = Path(delivery_execution["run_artifacts_root_path"])
    result = build_delivery_result_from_outcomes(
        deliveries=delivery_execution["deliveries"],
        keep_case_ids=delivery_execution["keep_case_ids"],
        patch_outcomes=patch_outcomes,
    )
    persist_delivery_result(run_artifacts_root=run_artifacts_root, result=result)
    return result


@activity.defn
def build_repository_review_result_activity(
    request: InternalWorkflowRequest,
    scan_result: Mapping[str, Any],
    case_results: Sequence[Mapping[str, Any]],
    delivery_result: Mapping[str, Any],
) -> dict[str, Any]:
    from sec_review_agents.utils.files import persist_json
    from sec_review_agents.utils.paths import required_path
    from sec_review_agents.workflows.repository.result import (
        build_repository_workflow_result,
    )

    run_artifacts_root = required_path(
        request.prepared_input["artifact_root_path"],
        label="artifact_root_path",
    )
    workflow_result = build_repository_workflow_result(
        discovery_result=scan_result["discovery_result"],
        triage_result=scan_result["triage_result"],
        delivery_result=delivery_result,
        case_results=case_results,
    )
    persist_json(
        run_artifacts_root,
        "repository-review-result.json",
        workflow_result,
    )
    return workflow_result


@workflow.defn
class RepositoryDiscoveryWorkflow:
    @workflow.run
    async def run(self, request: InternalWorkflowRequest) -> dict[str, Any]:
        manifest = await execute_activity(
            build_repository_discovery_manifest_activity,
            request,
            timeout_seconds=request.timeout_seconds,
        )
        max_concurrency = max(1, int(manifest["max_concurrency"]))
        chunks = list(manifest["chunks"])
        chunk_results: list[dict[str, Any] | None] = [None] * len(chunks)
        pending: dict[asyncio.Task, int] = {}
        next_index = 0

        def schedule_chunk(index: int) -> None:
            chunk = chunks[index]
            task = asyncio.create_task(
                execute_activity(
                    scan_repository_discovery_chunk_activity,
                    manifest,
                    chunk,
                    timeout_seconds=request.timeout_seconds,
                )
            )
            pending[task] = index

        while next_index < len(chunks) and len(pending) < max_concurrency:
            schedule_chunk(next_index)
            next_index += 1

        while pending:
            done, _ = await workflow.wait(
                pending.keys(),
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in done:
                index = pending.pop(task)
                chunk_results[index] = await task
                while next_index < len(chunks) and len(pending) < max_concurrency:
                    schedule_chunk(next_index)
                    next_index += 1
        return await execute_activity(
            build_repository_discovery_result_activity,
            manifest,
            [result for result in chunk_results if result is not None],
            timeout_seconds=request.timeout_seconds,
        )


@workflow.defn
class RepositoryScanWorkflow:
    @workflow.run
    async def run(self, request: InternalWorkflowRequest) -> dict[str, Any]:
        discovery_result = await workflow.execute_child_workflow(
            RepositoryDiscoveryWorkflow.run,
            request,
            id=f"{request.run_id}:discovery",
        )
        triage_result = await execute_activity(
            triage_repository_activity,
            request,
            discovery_result,
            timeout_seconds=request.timeout_seconds,
        )
        return {
            "discovery_result": discovery_result,
            "triage_result": triage_result,
        }


@workflow.defn
class RepositoryCaseReviewWorkflow:
    @workflow.run
    async def run(self, request: RepositoryCaseReviewRequest) -> dict[str, Any]:
        activity_timeout = timedelta(
            seconds=_repository_case_review_timeout_seconds(request)
        )
        retry_policy = activity_retry_policy()
        prepared_case = await workflow.execute_activity(
            prepare_repository_case_activity,
            args=[request],
            schedule_to_close_timeout=activity_timeout,
            retry_policy=retry_policy,
        )
        runtime_context = request["runtime_context"]
        analysis_result = await workflow.execute_activity(
            analyze_repository_case_activity,
            args=[prepared_case, runtime_context],
            schedule_to_close_timeout=activity_timeout,
            retry_policy=retry_policy,
        )
        # CVSS only depends on the analyzer result, so it can run while
        # mitigation works on the same case.
        cvss_task = asyncio.create_task(
            workflow.execute_activity(
                score_repository_case_cvss_activity,
                args=[prepared_case, analysis_result],
                schedule_to_close_timeout=activity_timeout,
                retry_policy=retry_policy,
            )
        )
        try:
            mitigation_result = await workflow.execute_activity(
                mitigate_repository_case_activity,
                args=[prepared_case, analysis_result, None, runtime_context],
                schedule_to_close_timeout=activity_timeout,
                retry_policy=retry_policy,
            )
            verifier_result = await workflow.execute_activity(
                verify_repository_case_activity,
                args=[
                    prepared_case,
                    analysis_result,
                    mitigation_result,
                    None,
                    runtime_context,
                ],
                schedule_to_close_timeout=activity_timeout,
                retry_policy=retry_policy,
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
                await workflow.execute_activity(
                    archive_repository_case_feedback_attempt_activity,
                    args=[prepared_case, retry_context],
                    schedule_to_close_timeout=activity_timeout,
                    retry_policy=retry_policy,
                )
                mitigation_result = await workflow.execute_activity(
                    mitigate_repository_case_activity,
                    args=[
                        prepared_case,
                        analysis_result,
                        retry_context,
                        runtime_context,
                    ],
                    schedule_to_close_timeout=activity_timeout,
                    retry_policy=retry_policy,
                )
                verifier_result = await workflow.execute_activity(
                    verify_repository_case_activity,
                    args=[
                        prepared_case,
                        analysis_result,
                        mitigation_result,
                        retry_context,
                        runtime_context,
                    ],
                    schedule_to_close_timeout=activity_timeout,
                    retry_policy=retry_policy,
                )
            # CVSS is advisory for the case record. If scoring exhausts retries,
            # preserve the mitigation/verifier result and leave public CVSS empty.
            try:
                cvss_result = await cvss_task
            except Exception as cvss_error:
                cvss_result = await workflow.execute_activity(
                    build_failed_repository_case_cvss_result_activity,
                    args=[prepared_case, _stage_error_message(cvss_error)],
                    schedule_to_close_timeout=activity_timeout,
                    retry_policy=retry_policy,
                )
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
        return await workflow.execute_activity(
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


@workflow.defn
# Repository case-processing stage: runs case review workflows for triaged cases.
class RepositoryCaseProcessingWorkflow:
    @workflow.run
    async def run(
        self,
        request: InternalWorkflowRequest,
        scan_result: dict[str, Any],
    ) -> list[dict[str, Any]]:
        cases = list(scan_result["triage_result"]["cases"])
        case_batch = await execute_activity(
            prepare_repository_case_review_inputs_activity,
            request,
            cases,
            timeout_seconds=request.timeout_seconds,
        )
        case_requests = list(case_batch["case_requests"])
        max_concurrency = max(1, int(case_batch["max_concurrency"]))
        case_results: list[dict[str, Any] | None] = [None] * len(case_requests)
        pending: dict[asyncio.Task, int] = {}
        next_index = 0

        def schedule_case(index: int) -> None:
            case_request = case_requests[index]
            task = asyncio.create_task(
                workflow.execute_child_workflow(
                    RepositoryCaseReviewWorkflow.run,
                    case_request,
                    id=_repository_case_workflow_id(request, case_request),
                )
            )
            pending[task] = index

        while next_index < len(case_requests) and len(pending) < max_concurrency:
            schedule_case(next_index)
            next_index += 1

        while pending:
            done, _ = await workflow.wait(
                pending.keys(),
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in done:
                index = pending.pop(task)
                case_request = case_requests[index]
                try:
                    case_results[index] = await task
                except Exception as error:
                    case_results[index] = build_blocked_repository_case_result(
                        case_request,
                        f"Case processing failed after retries: {error}",
                    )
                while (
                    next_index < len(case_requests) and len(pending) < max_concurrency
                ):
                    schedule_case(next_index)
                    next_index += 1

        return [result for result in case_results if result is not None]


@workflow.defn
class RepositoryDeliveryWorkflow:
    @workflow.run
    async def run(
        self,
        request: InternalWorkflowRequest,
        case_results: Sequence[Mapping[str, Any]],
    ) -> dict[str, Any]:
        delivery_plan = await execute_activity(
            plan_repository_delivery_activity,
            request,
            case_results,
            timeout_seconds=request.timeout_seconds,
        )
        deliveries = list(delivery_plan["deliveries"])
        if not deliveries:
            return await execute_activity(
                build_skipped_repository_delivery_result_activity,
                request,
                timeout_seconds=request.timeout_seconds,
            )

        delivery_execution = await execute_activity(
            prepare_repository_delivery_execution_activity,
            request,
            case_results,
            delivery_plan,
            timeout_seconds=request.timeout_seconds,
        )
        single_outcomes = await execute_activity(
            execute_repository_single_deliveries_activity,
            delivery_execution,
            timeout_seconds=request.timeout_seconds,
        )
        combined_delivery_execution_items = list(
            delivery_execution["combined_delivery_execution_items"]
        )
        max_concurrency = max(1, int(delivery_execution["max_concurrency"]))
        patch_outcomes: list[dict[str, Any] | None] = [None] * len(deliveries)
        pending: dict[asyncio.Task, int] = {}
        next_index = 0

        for item in single_outcomes:
            patch_outcomes[int(item["index"])] = item["outcome"]

        def schedule_delivery(index: int) -> None:
            delivery_request = combined_delivery_execution_items[index]
            task = asyncio.create_task(
                execute_activity(
                    execute_repository_combined_delivery_activity,
                    delivery_execution,
                    delivery_request,
                    timeout_seconds=request.timeout_seconds,
                )
            )
            pending[task] = int(delivery_request["index"])

        while (
            next_index < len(combined_delivery_execution_items)
            and len(pending) < max_concurrency
        ):
            schedule_delivery(next_index)
            next_index += 1

        while pending:
            done, _ = await workflow.wait(
                pending.keys(),
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in done:
                index = pending.pop(task)
                patch_outcomes[index] = await task
                while (
                    next_index < len(combined_delivery_execution_items)
                    and len(pending) < max_concurrency
                ):
                    schedule_delivery(next_index)
                    next_index += 1

        return await execute_activity(
            build_repository_delivery_result_activity,
            delivery_execution,
            [outcome for outcome in patch_outcomes if outcome is not None],
            timeout_seconds=request.timeout_seconds,
        )


@workflow.defn
class RepositoryReviewWorkflow:
    @workflow.run
    async def run(self, request: InternalWorkflowRequest) -> dict[str, Any]:
        await execute_activity(
            prepare_internal_workflow_activity,
            request.workflow,
            request.run_id,
            timeout_seconds=request.timeout_seconds,
        )
        scan_result = await workflow.execute_child_workflow(
            RepositoryScanWorkflow.run,
            request,
            id=f"{request.run_id}:scan",
        )
        case_results = await workflow.execute_child_workflow(
            RepositoryCaseProcessingWorkflow.run,
            args=[request, scan_result],
            id=f"{request.run_id}:review",
        )
        delivery_result = await workflow.execute_child_workflow(
            RepositoryDeliveryWorkflow.run,
            args=[request, case_results],
            id=f"{request.run_id}:delivery",
        )
        result = await execute_activity(
            build_repository_review_result_activity,
            request,
            scan_result,
            case_results,
            delivery_result,
            timeout_seconds=request.timeout_seconds,
        )
        await register_memory_extraction_for_review(request)
        return {"ok": True, "result": result}


def _repository_case_workflow_id(
    request: InternalWorkflowRequest,
    case_request: RepositoryCaseReviewRequest,
) -> str:
    case_id = str(case_request["case_execution_input"]["case_id"]).strip()
    return f"{request.run_id}:case:{case_id}"


__all__ = [
    "RepositoryCaseProcessingWorkflow",
    "RepositoryCaseReviewWorkflow",
    "RepositoryDeliveryWorkflow",
    "RepositoryDiscoveryWorkflow",
    "RepositoryReviewWorkflow",
    "RepositoryScanWorkflow",
    "analyze_repository_case_activity",
    "archive_repository_case_feedback_attempt_activity",
    "build_blocked_repository_case_result",
    "build_failed_repository_case_cvss_result_activity",
    "build_repository_case_result_activity",
    "build_repository_delivery_result_activity",
    "build_repository_discovery_manifest_activity",
    "build_repository_discovery_result_activity",
    "build_repository_review_result_activity",
    "build_skipped_repository_delivery_result_activity",
    "execute_repository_combined_delivery_activity",
    "execute_repository_single_deliveries_activity",
    "mitigate_repository_case_activity",
    "plan_repository_delivery_activity",
    "prepare_repository_case_activity",
    "prepare_repository_case_review_inputs_activity",
    "prepare_repository_delivery_execution_activity",
    "project_repository_case_result_for_delivery",
    "scan_repository_discovery_chunk_activity",
    "score_repository_case_cvss_activity",
    "triage_repository_activity",
    "verify_repository_case_activity",
]
