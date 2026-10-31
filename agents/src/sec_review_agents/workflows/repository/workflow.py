import asyncio
from collections.abc import Mapping, Sequence
from datetime import timedelta
from pathlib import Path
from typing import Any, TypedDict

from temporalio import activity, workflow

from sec_review_agents.delivery_stages.model import DeliveryCaseInput
from sec_review_agents.review_stages.record import build_review_record
from sec_review_agents.run_diagnostics.publication import (
    RunDiagnosticPublicationRequest,
    publish_run_diagnostic_activity,
)
from sec_review_agents.scan_stages.discovery.input import (
    DiscoveryChunk,
    DiscoveryManifest,
)
from sec_review_agents.scan_stages.discovery.result import (
    DiscoveryChunkResult,
    DiscoveryResult,
)
from sec_review_agents.scan_stages.triage.result import TriageResult
from sec_review_agents.temporal.support import (
    activity_retry_policy,
)
from sec_review_agents.workflows.memory.scheduling import schedule_memory_extractions
from sec_review_agents.workflows.repository.scan_result import RepositoryScanResult
from sec_review_agents.workflows.repository_case.workflow import (
    RepositoryCaseReviewRequest,
    RepositoryCaseReviewWorkflow,
)
from sec_review_agents.workflows.review_intent import (
    REVIEW_OBJECTIVE_AUDIT,
    require_review_intent,
)
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest

DEFAULT_CASE_PROCESSING_MAX_CONCURRENCY = 1


class RepositoryCaseRequestBatch(TypedDict):
    max_concurrency: int
    case_requests: list[RepositoryCaseReviewRequest]


def build_blocked_repository_case_result(
    case_request: RepositoryCaseReviewRequest,
    reason: str,
) -> dict[str, Any]:
    return {
        "case_id": case_request["case_execution_input"]["case_id"].strip(),
        "disposition": "blocked",
        "reason": reason,
        "review_record": build_review_record(
            analysis_result=None,
            mitigation_result=None,
            verifier_result=None,
            cvss_result=None,
        ).model_dump(mode="json", by_alias=True),
    }


def _repository_case_timeout_seconds(
    request: ReviewWorkflowRequest,
) -> int:
    timeout_seconds = request.timeout_seconds
    if (
        not isinstance(timeout_seconds, int)
        or isinstance(timeout_seconds, bool)
        or timeout_seconds < 1
    ):
        raise ValueError("Repository case activity timeout must be a positive integer.")
    return timeout_seconds


def resolve_repository_case_processing_max_concurrency(case_count: int) -> int:
    from sec_review_agents.utils.env import int_env

    if case_count <= 0:
        return 1
    configured = int_env(
        "AGENT_CASE_PROCESSING_MAX_CONCURRENCY",
        DEFAULT_CASE_PROCESSING_MAX_CONCURRENCY,
        minimum=1,
    )
    return min(case_count, configured)


@activity.defn
def build_repository_discovery_manifest_activity(
    request: ReviewWorkflowRequest,
) -> DiscoveryManifest:
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
    request: ReviewWorkflowRequest,
    manifest: DiscoveryManifest,
    chunk: DiscoveryChunk,
) -> DiscoveryChunkResult:
    from pathlib import Path

    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.scan_stages.discovery.stage import scan_discovery_chunk
    from sec_review_agents.temporal.support import activity_trace_labels

    with bind_trace_context(
        **activity_trace_labels(
            workflow_name=request.workflow,
            run_id=request.run_id,
            chunk_id=chunk.chunk_id,
        )
    ):
        return await scan_discovery_chunk(
            chunk=chunk,
            root=Path(manifest.workspace_root),
            discovery_artifacts_path=Path(manifest.discovery_artifacts_path),
        )


@activity.defn
def build_repository_discovery_result_activity(
    manifest: DiscoveryManifest,
    chunk_results: Sequence[DiscoveryChunkResult],
) -> DiscoveryResult:
    from sec_review_agents.scan_stages.discovery.stage import (
        build_discovery_result_from_chunks,
        persist_discovery_result,
    )

    result = build_discovery_result_from_chunks(
        entries=manifest.entries,
        skipped_files=manifest.skipped_files,
        chunks=manifest.chunks,
        chunk_results=chunk_results,
        scan_mode=manifest.scan_mode,
        deployment_input_limit_tokens=manifest.deployment_input_limit_tokens,
        chunk_target_tokens=manifest.chunk_target_tokens,
        chunk_target_ratio=manifest.chunk_target_ratio,
        chunk_hard_limit_tokens=manifest.chunk_hard_limit_tokens,
        discovery_concurrency=manifest.max_concurrency,
        chunk_strategy=manifest.chunk_strategy,
    )
    persist_discovery_result(
        discovery_artifacts_path=Path(manifest.discovery_artifacts_path),
        result=result,
    )
    return result


@activity.defn
async def triage_repository_activity(
    request: ReviewWorkflowRequest,
    discovery_result: DiscoveryResult,
) -> TriageResult:
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.scan_stages.triage.stage import run_repository_triage_stage
    from sec_review_agents.temporal.support import activity_trace_labels
    from sec_review_agents.utils.paths import artifact_path

    with bind_trace_context(
        **activity_trace_labels(
            workflow_name=request.workflow,
            run_id=request.run_id,
        )
    ):
        return await run_repository_triage_stage(
            triage_root=artifact_path(
                request.prepared_input["artifact_paths"], "triage"
            ),
            discovery_result=discovery_result,
        )


@activity.defn
def prepare_repository_case_review_inputs_activity(
    request: ReviewWorkflowRequest,
    cases: Sequence[Mapping[str, Any]],
) -> RepositoryCaseRequestBatch:
    from sec_review_agents.review_stages.trajectories import (
        review_trajectories_root,
    )
    from sec_review_agents.runtime.setup_bootstrap import (
        setup_declaration_content_for_backend,
    )
    from sec_review_agents.utils.paths import (
        artifact_path,
        required_path,
    )
    from sec_review_agents.workflows.repository.case_execution_input import (
        deleted_repository_cases,
        prepare_case_execution_input,
    )

    prepared_input = request.prepared_input
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
    scan_target = prepared_input["scan_target"]
    scan_mode = str(scan_target["scan_mode"])
    review_intent = require_review_intent(prepared_input.get("review_intent"))
    timeout_seconds = _repository_case_timeout_seconds(request)
    # A deleted file has no current content, so no single-file scan can produce a candidate for it.
    # Its case is built from the window itself and enters the same batch as triaged cases, which
    # keeps the analyzer as the single place that decides whether any case is a real finding.
    deletion_cases = (
        deleted_repository_cases(
            scan_scope=prepared_input["scan_scope"],
            base_sha=str(scan_target.get("base_sha") or ""),
            head_sha=str(scan_target.get("head_sha") or ""),
        )
        if scan_mode == "incremental"
        else []
    )
    all_cases = [*cases, *deletion_cases]
    # Both kinds end up as case workflows under one run id, so a repeated id would make two cases
    # collide on the same child workflow and artifact directory.
    case_ids = [str(case.get("case_id") or "") for case in all_cases]
    if len(set(case_ids)) != len(case_ids):
        raise ValueError("Repository case ids must be unique within a run.")
    return {
        "max_concurrency": resolve_repository_case_processing_max_concurrency(
            len(all_cases)
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
                    test_changes=review_intent.test_changes,
                    setup_declaration_content=setup_declaration_content_for_backend(
                        prepared_input
                    ),
                ),
                "cases_artifacts_path": str(cases_artifacts_path),
                "published_trajectories_path": str(
                    review_trajectories_root(
                        cases_artifacts_path / str(case.get("case_id") or index),
                    )
                ),
                "timeout_seconds": timeout_seconds,
                "runtime_context": request.runtime_context,
            }
            for index, case in enumerate(all_cases, start=1)
        ],
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
    request: ReviewWorkflowRequest,
    case_results: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    from sec_review_agents.delivery_stages.planning import (
        build_skipped_delivery_plan,
        generate_delivery_plan,
        persist_delivery_plan,
    )
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.temporal.support import activity_trace_labels
    from sec_review_agents.utils.paths import required_path

    prepared_input = request.prepared_input
    run_artifacts_root = required_path(
        prepared_input["artifact_root_path"],
        label="artifact_root_path",
    )
    delivery_case_inputs = _delivery_case_inputs(case_results)
    if not delivery_case_inputs:
        result = build_skipped_delivery_plan(total_case_count=len(case_results))
        persist_delivery_plan(
            run_artifacts_root=run_artifacts_root,
            result=result,
        )
        return result
    with bind_trace_context(
        **activity_trace_labels(
            workflow_name=request.workflow,
            run_id=request.run_id,
        )
    ):
        return await generate_delivery_plan(
            run_artifacts_root=run_artifacts_root,
            case_results=delivery_case_inputs,
        )


@activity.defn
def prepare_repository_delivery_execution_activity(
    request: ReviewWorkflowRequest,
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
    request: ReviewWorkflowRequest,
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
    request: ReviewWorkflowRequest,
    delivery_execution: Mapping[str, Any],
) -> list[dict[str, Any]]:
    from pathlib import Path

    from sec_review_agents.delivery_stages.execution import (
        execute_delivery_entry,
    )
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.temporal.support import activity_trace_labels

    outcomes = []
    for delivery_request in delivery_execution["single_delivery_execution_items"]:
        delivery = delivery_request["delivery"]
        delivery_id = str(delivery.get("delivery_id") or "").strip() or None
        with bind_trace_context(
            **activity_trace_labels(
                workflow_name=request.workflow,
                run_id=request.run_id,
                delivery_id=delivery_id,
            )
        ):
            outcome = await execute_delivery_entry(
                run_artifacts_root=Path(delivery_execution["run_artifacts_root_path"]),
                delivery_entry=delivery,
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
    request: ReviewWorkflowRequest,
    delivery_execution: Mapping[str, Any],
    delivery_request: Mapping[str, Any],
) -> dict[str, Any] | None:
    from pathlib import Path

    from sec_review_agents.delivery_stages.execution import (
        execute_delivery_entry,
    )
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.temporal.support import activity_trace_labels

    run_artifacts_root = Path(delivery_execution["run_artifacts_root_path"])
    delivery_entry = delivery_request["delivery"]
    delivery_id = str(delivery_entry.get("delivery_id") or "").strip() or None
    with bind_trace_context(
        **activity_trace_labels(
            workflow_name=request.workflow,
            run_id=request.run_id,
            delivery_id=delivery_id,
        )
    ):
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
    request: ReviewWorkflowRequest,
    scan_result: RepositoryScanResult,
    case_results: Sequence[Mapping[str, Any]],
    delivery_result: Mapping[str, Any],
) -> dict[str, Any]:
    from sec_review_agents.utils.files import persist_json_artifact
    from sec_review_agents.utils.paths import required_path
    from sec_review_agents.workflows.repository.result import (
        build_repository_workflow_result,
    )

    run_artifacts_root = required_path(
        request.prepared_input["artifact_root_path"],
        label="artifact_root_path",
    )
    workflow_result = build_repository_workflow_result(
        scan_result=scan_result,
        delivery_result=delivery_result,
        case_results=case_results,
    )
    persist_json_artifact(
        run_artifacts_root,
        "repository-review-result",
        workflow_result,
    )
    return workflow_result


@workflow.defn
class RepositoryDiscoveryWorkflow:
    @workflow.run
    async def run(self, request: ReviewWorkflowRequest) -> DiscoveryResult:
        manifest = await workflow.execute_activity(
            build_repository_discovery_manifest_activity,
            args=[request],
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        max_concurrency = max(1, manifest.max_concurrency)
        chunks = manifest.chunks
        chunk_results: list[DiscoveryChunkResult | None] = [None] * len(chunks)
        pending: dict[asyncio.Task, int] = {}
        next_index = 0

        def schedule_chunk(index: int) -> None:
            chunk = chunks[index]
            task = asyncio.create_task(
                workflow.execute_activity(
                    scan_repository_discovery_chunk_activity,
                    args=[request, manifest, chunk],
                    schedule_to_close_timeout=timedelta(
                        seconds=request.timeout_seconds
                    ),
                    retry_policy=activity_retry_policy(),
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
        discovery_result = await workflow.execute_activity(
            build_repository_discovery_result_activity,
            args=[
                manifest,
                [result for result in chunk_results if result is not None],
            ],
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        return discovery_result


@activity.defn
def window_deletion_summary_activity(
    request: ReviewWorkflowRequest,
) -> dict[str, Any]:
    from sec_review_agents.workflows.repository.case_execution_input import (
        window_deletion_summary,
    )

    return window_deletion_summary(
        scan_scope=request.prepared_input["scan_scope"],
        scan_mode=str(request.prepared_input["scan_target"]["scan_mode"]),
    )


@workflow.defn
class RepositoryScanWorkflow:
    @workflow.run
    async def run(self, request: ReviewWorkflowRequest) -> RepositoryScanResult:
        discovery_result = await workflow.execute_child_workflow(
            RepositoryDiscoveryWorkflow.run,
            request,
            id=f"{request.run_id}:discovery",
        )
        triage_result = await workflow.execute_activity(
            triage_repository_activity,
            args=[request, discovery_result],
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        window_deletions = await workflow.execute_activity(
            window_deletion_summary_activity,
            args=[request],
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        return RepositoryScanResult(
            discovery_result=discovery_result,
            triage_result=triage_result,
            **window_deletions,
        )


@workflow.defn
# Repository case-processing stage: runs case review workflows for triaged cases.
class RepositoryCaseProcessingWorkflow:
    @workflow.run
    async def run(
        self,
        request: ReviewWorkflowRequest,
        scan_result: RepositoryScanResult,
    ) -> list[dict[str, Any]]:
        cases = [
            case.model_dump(mode="json") for case in scan_result.triage_result.cases
        ]
        case_batch = await workflow.execute_activity(
            prepare_repository_case_review_inputs_activity,
            args=[request, cases],
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
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
        request: ReviewWorkflowRequest,
        case_results: Sequence[Mapping[str, Any]],
    ) -> dict[str, Any]:
        delivery_plan = await workflow.execute_activity(
            plan_repository_delivery_activity,
            args=[request, case_results],
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        deliveries = list(delivery_plan["deliveries"])
        if not deliveries:
            return await workflow.execute_activity(
                build_skipped_repository_delivery_result_activity,
                args=[request],
                schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
                retry_policy=activity_retry_policy(),
            )

        delivery_execution = await workflow.execute_activity(
            prepare_repository_delivery_execution_activity,
            args=[request, case_results, delivery_plan],
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        single_outcomes = await workflow.execute_activity(
            execute_repository_single_deliveries_activity,
            args=[request, delivery_execution],
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
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
                workflow.execute_activity(
                    execute_repository_combined_delivery_activity,
                    args=[request, delivery_execution, delivery_request],
                    schedule_to_close_timeout=timedelta(
                        seconds=request.timeout_seconds
                    ),
                    retry_policy=activity_retry_policy(),
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

        return await workflow.execute_activity(
            build_repository_delivery_result_activity,
            args=[
                delivery_execution,
                [outcome for outcome in patch_outcomes if outcome is not None],
            ],
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )


@workflow.defn
class RepositoryReviewWorkflow:
    @workflow.run
    async def run(self, request: ReviewWorkflowRequest) -> dict[str, Any]:
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
        result = await workflow.execute_activity(
            build_repository_review_result_activity,
            args=[request, scan_result, case_results, delivery_result],
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        artifact_root = Path(str(request.prepared_input["artifact_root_path"]))
        review_units = [
            {
                "unit_id": str(case_result["case_id"]),
                "trajectory_root": str(
                    artifact_root
                    / "cases"
                    / str(case_result["case_id"])
                    / "trajectories"
                ),
            }
            for case_result in case_results
            if isinstance(case_result.get("case_id"), str)
        ]
        finalized = await workflow.execute_activity(
            publish_run_diagnostic_activity,
            args=[
                RunDiagnosticPublicationRequest(
                    run_id=request.run_id,
                    artifact_root_path=str(artifact_root),
                    review_units=review_units,
                    result=result,
                    destination_scheme=request.post_processing.diagnostic_scheme,
                )
            ],
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        memory_processing: dict[str, Any] | None = None
        if review_units:
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


def _repository_case_workflow_id(
    request: ReviewWorkflowRequest,
    case_request: RepositoryCaseReviewRequest,
) -> str:
    case_id = str(case_request["case_execution_input"]["case_id"]).strip()
    return f"{request.run_id}:case:{case_id}"


__all__ = [
    "RepositoryCaseProcessingWorkflow",
    "RepositoryDeliveryWorkflow",
    "RepositoryDiscoveryWorkflow",
    "RepositoryReviewWorkflow",
    "RepositoryScanWorkflow",
    "build_blocked_repository_case_result",
    "build_repository_delivery_result_activity",
    "build_repository_discovery_manifest_activity",
    "build_repository_discovery_result_activity",
    "build_repository_review_result_activity",
    "build_skipped_repository_delivery_result_activity",
    "execute_repository_combined_delivery_activity",
    "execute_repository_single_deliveries_activity",
    "plan_repository_delivery_activity",
    "prepare_repository_case_review_inputs_activity",
    "prepare_repository_delivery_execution_activity",
    "project_repository_case_result_for_delivery",
    "scan_repository_discovery_chunk_activity",
    "triage_repository_activity",
]
