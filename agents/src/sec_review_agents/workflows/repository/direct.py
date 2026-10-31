import asyncio
from collections.abc import Sequence
from typing import Any

from sec_review_agents.delivery_stages.execution.input import (
    build_delivery_execution_input,
    persist_delivery_execution_input,
)
from sec_review_agents.delivery_stages.execution.result import DeliveryExecutionResult
from sec_review_agents.delivery_stages.execution.stage import execute_delivery_entry
from sec_review_agents.delivery_stages.result import (
    DeliveryResult,
    build_delivery_result_from_outcomes,
    build_skipped_delivery_result,
    persist_delivery_result,
)
from sec_review_agents.scan_stages.discovery.input import DiscoveryChunk
from sec_review_agents.scan_stages.discovery.result import (
    DiscoveryChunkResult,
    DiscoveryResult,
)
from sec_review_agents.utils.paths import required_path
from sec_review_agents.workflows.repository.scan_result import RepositoryScanResult
from sec_review_agents.workflows.repository.workflow import (
    build_blocked_repository_case_result,
    build_repository_discovery_manifest_activity,
    build_repository_discovery_result_activity,
    build_repository_review_result_activity,
    plan_repository_delivery_activity,
    prepare_repository_case_review_inputs_activity,
    scan_repository_discovery_chunk_activity,
    triage_repository_activity,
    window_deletion_summary_activity,
)
from sec_review_agents.workflows.repository_case import direct as repository_case_direct
from sec_review_agents.workflows.repository_case.result import RepositoryCaseResult
from sec_review_agents.workflows.repository_case.workflow import (
    RepositoryCaseReviewRequest,
)
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest


async def run_repository_review_direct(
    request: ReviewWorkflowRequest,
) -> dict[str, Any]:
    scan_result = await run_repository_scan_direct(request)
    case_results = await run_repository_case_reviews_direct(request, scan_result)
    delivery_result = await run_repository_delivery_direct(request, case_results)
    return build_repository_review_result_activity(
        request,
        scan_result,
        case_results,
        delivery_result,
    )


async def run_repository_scan_direct(
    request: ReviewWorkflowRequest,
) -> RepositoryScanResult:
    discovery_result = await run_repository_discovery_direct(request)
    triage_result = await triage_repository_activity(request, discovery_result)
    window_deletions = window_deletion_summary_activity(request)
    return RepositoryScanResult(
        discovery_result=discovery_result,
        triage_result=triage_result,
        deleted_file_count=window_deletions.deleted_file_count,
        deletion_review_skipped=window_deletions.deletion_review_skipped,
    )


async def run_repository_discovery_direct(
    request: ReviewWorkflowRequest,
) -> DiscoveryResult:
    manifest = build_repository_discovery_manifest_activity(request)
    max_concurrency = max(1, manifest.max_concurrency)
    chunks = manifest.chunks

    semaphore = asyncio.Semaphore(max_concurrency)

    async def scan_chunk(
        index: int, chunk: DiscoveryChunk
    ) -> tuple[int, DiscoveryChunkResult]:
        async with semaphore:
            return index, await scan_repository_discovery_chunk_activity(
                request, manifest, chunk
            )

    chunk_results: list[DiscoveryChunkResult | None] = [None] * len(chunks)
    for index, result in await asyncio.gather(
        *(scan_chunk(index, chunk) for index, chunk in enumerate(chunks))
    ):
        chunk_results[index] = result

    return build_repository_discovery_result_activity(
        manifest,
        [result for result in chunk_results if result is not None],
    )


async def run_repository_case_reviews_direct(
    request: ReviewWorkflowRequest,
    scan_result: RepositoryScanResult,
) -> list[RepositoryCaseResult]:
    cases = scan_result.triage_result.cases
    case_batch = prepare_repository_case_review_inputs_activity(request, cases)
    case_requests = case_batch.case_requests
    max_concurrency = case_batch.max_concurrency
    semaphore = asyncio.Semaphore(max_concurrency)

    async def run_case(
        index: int, case_request: RepositoryCaseReviewRequest
    ) -> tuple[int, RepositoryCaseResult]:
        async with semaphore:
            try:
                return (
                    index,
                    await repository_case_direct.run_repository_case_review_direct(
                        case_request
                    ),
                )
            except Exception as error:
                return index, build_blocked_repository_case_result(
                    case_request,
                    f"Case processing failed: {error}",
                )

    case_results: list[RepositoryCaseResult | None] = [None] * len(case_requests)
    for index, result in await asyncio.gather(
        *(
            run_case(index, case_request)
            for index, case_request in enumerate(case_requests)
        )
    ):
        case_results[index] = result
    return [result for result in case_results if result is not None]


async def run_repository_delivery_direct(
    request: ReviewWorkflowRequest,
    case_results: Sequence[RepositoryCaseResult],
) -> DeliveryResult:
    delivery_plan = await plan_repository_delivery_activity(request, case_results)
    deliveries = delivery_plan.deliveries
    run_artifacts_root = required_path(
        request.prepared_input.artifact_root_path,
        label="artifact_root_path",
    )
    if not deliveries:
        result = build_skipped_delivery_result()
        persist_delivery_result(run_artifacts_root=run_artifacts_root, result=result)
        return result

    from sec_review_agents.workflows.repository.workflow import (
        project_repository_case_result_for_delivery,
    )

    keep_case_results = [
        project_repository_case_result_for_delivery(item)
        for item in case_results
        if item.disposition == "keep"
    ]
    persist_delivery_execution_input(
        run_artifacts_root=run_artifacts_root,
        deliveries=deliveries,
        keep_case_results=keep_case_results,
    )
    workspace_snapshot_tar_path = required_path(
        request.prepared_input.workspace_snapshot_tar_path,
        label="workspace_snapshot_tar_path",
    )
    delivery_execution = build_delivery_execution_input(
        run_artifacts_root=run_artifacts_root,
        workspace_snapshot_tar_path=workspace_snapshot_tar_path,
        deliveries=deliveries,
        keep_case_results=keep_case_results,
    )
    patch_outcomes: list[DeliveryExecutionResult | None] = [None] * len(deliveries)
    for delivery_request in delivery_execution.single_delivery_execution_items:
        patch_outcomes[delivery_request.index] = await execute_delivery_entry(
            run_artifacts_root=run_artifacts_root,
            delivery_entry=delivery_request.delivery,
            case_results=delivery_request.case_items,
        )
    combined_delivery_execution_items = (
        delivery_execution.combined_delivery_execution_items
    )
    for delivery_request in combined_delivery_execution_items:
        delivery_index = delivery_request.index
        patch_outcomes[delivery_index] = await execute_delivery_entry(
            run_artifacts_root=run_artifacts_root,
            baseline_snapshot_tar_path=workspace_snapshot_tar_path,
            delivery_entry=delivery_request.delivery,
            case_results=delivery_request.case_items,
        )

    result = build_delivery_result_from_outcomes(
        deliveries=deliveries,
        keep_case_ids=delivery_execution.keep_case_ids,
        patch_outcomes=[outcome for outcome in patch_outcomes if outcome is not None],
    )
    persist_delivery_result(run_artifacts_root=run_artifacts_root, result=result)
    return result


__all__ = [
    "run_repository_review_direct",
]
