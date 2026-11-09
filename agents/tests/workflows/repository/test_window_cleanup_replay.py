"""Replay the cancellation commands emitted when a bounded workflow window exits."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path

import pytest
from temporalio import activity
from temporalio.api.enums.v1 import EventType
from temporalio.client import WorkflowFailureError
from temporalio.exceptions import ApplicationError
from temporalio.worker import Replayer, Worker

from sec_review_agents.scan_stages.discovery.input import (
    DiscoveryChunk,
    DiscoveryManifest,
)
from sec_review_agents.scan_stages.discovery.result import (
    DiscoveryChunkResult,
    DiscoveryResult,
)
from sec_review_agents.workflows.repository.workflow import RepositoryDiscoveryWorkflow
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest
from tests.prepared_input_fixtures import prepared_repository_input
from tests.temporal_test_utils import temporal_time_skipping_environment


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["failure", "cancel"])
async def test_workflow_window_cleanup_has_stable_cancel_order_and_replays(
    tmp_path: Path, outcome: str
) -> None:
    """Cancellation emits durable commands, so cleanup order is part of replay correctness."""
    started = [asyncio.Event() for _ in range(3)]
    fail = asyncio.Event()

    @activity.defn(name="build_repository_discovery_manifest_activity")
    async def manifest(_request: ReviewWorkflowRequest) -> DiscoveryManifest:
        return DiscoveryManifest(
            workspace_root=str(tmp_path),
            discovery_artifacts_path=str(tmp_path),
            scan_mode="full",
            entries=[],
            skipped_files=[],
            chunks=[
                DiscoveryChunk(chunk_id=f"chunk-{i}", entries=[], token_count=0)
                for i in range(3)
            ],
            deployment_input_limit_tokens=1000,
            chunk_target_tokens=200,
            chunk_target_ratio="1/5",
            chunk_hard_limit_tokens=800,
            chunk_strategy="batched",
            max_concurrency=2,
        )

    @activity.defn(name="scan_repository_discovery_chunk_activity")
    async def scan(
        _request: ReviewWorkflowRequest,
        _manifest: DiscoveryManifest,
        chunk: DiscoveryChunk,
    ) -> DiscoveryChunkResult:
        index = int(chunk.chunk_id.split("-")[1])
        started[index].set()
        if index == 1 and outcome == "failure":
            await fail.wait()
            raise ApplicationError("Chunk failed.", non_retryable=True)
        while True:
            activity.heartbeat()
            await asyncio.sleep(0.01)

    @activity.defn(name="build_repository_discovery_result_activity")
    async def result(
        _manifest: DiscoveryManifest, _results: list[DiscoveryChunkResult]
    ) -> DiscoveryResult:
        raise AssertionError("An interrupted scan must not aggregate a partial result.")

    async with (
        temporal_time_skipping_environment() as env,
        Worker(
            env.client,
            task_queue="window-cleanup-replay",
            workflows=[RepositoryDiscoveryWorkflow],
            activities=[manifest, scan, result],
            default_heartbeat_throttle_interval=timedelta(milliseconds=10),
        ),
    ):
        handle = await env.client.start_workflow(
            RepositoryDiscoveryWorkflow.run,
            ReviewWorkflowRequest(
                workflow="repository-review",
                run_id="window-cleanup-replay",
                prepared_input=prepared_repository_input(),
                timeout_seconds=30,
                runtime_context={},
            ),
            id=f"window-cleanup-{outcome}",
            task_queue="window-cleanup-replay",
        )
        for started_event in started[:2]:
            await asyncio.wait_for(started_event.wait(), timeout=5)
        if outcome == "failure":
            fail.set()
        else:
            await handle.cancel()
        with pytest.raises(WorkflowFailureError):
            await asyncio.wait_for(handle.result(), timeout=10)
        assert not started[2].is_set()
        history = await handle.fetch_history()
        scheduled_chunks: dict[int, str] = {}
        cancelled: list[str] = []
        for event in history.events:
            if event.event_type == EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED:
                scheduled = event.activity_task_scheduled_event_attributes
                if (
                    scheduled.activity_type.name
                    == "scan_repository_discovery_chunk_activity"
                ):
                    decoded = await env.client.data_converter.decode(
                        [scheduled.input.payloads[2]], [DiscoveryChunk]
                    )
                    scheduled_chunks[event.event_id] = decoded[0].chunk_id
            elif (
                event.event_type == EventType.EVENT_TYPE_ACTIVITY_TASK_CANCEL_REQUESTED
            ):
                cancelled.append(
                    scheduled_chunks[
                        event.activity_task_cancel_requested_event_attributes.scheduled_event_id
                    ]
                )
        assert cancelled == (
            ["chunk-0"] if outcome == "failure" else ["chunk-0", "chunk-1"]
        )
        await Replayer(
            workflows=[RepositoryDiscoveryWorkflow],
            data_converter=env.client.data_converter,
        ).replay_workflow(history)


@pytest.mark.asyncio
async def test_delivery_workflow_refills_isolates_synthesis_failure_and_replays(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sec_review_agents.delivery_stages.execution.input import (
        DeliveryExecutionInput,
        DeliveryExecutionItem,
        build_delivery_execution_input,
    )
    from sec_review_agents.delivery_stages.execution.result import (
        DeliveryExecutionResult,
    )
    from sec_review_agents.delivery_stages.model import DeliveryEntry, DeliveryPlan
    from sec_review_agents.workflows.repository.workflow import (
        RepositoryDeliveryWorkflow,
        build_repository_delivery_result_activity,
        execute_repository_single_deliveries_activity,
        project_repository_case_result_for_delivery,
    )
    from sec_review_agents.workflows.repository_case.result import RepositoryCaseResult

    monkeypatch.setenv("REPOSITORY_PATCH_SYNTHESIS_MAX_CONCURRENCY", "2")
    deliveries = [
        DeliveryEntry(
            delivery_id="single",
            strategy="single",
            case_ids=["single-case"],
            reason="Independent repair.",
        )
    ] + [
        DeliveryEntry(
            delivery_id=f"combined-{i}",
            strategy="combined",
            case_ids=[f"case-{i}-a", f"case-{i}-b"],
            reason="Combined repair.",
        )
        for i in range(3)
    ]
    cases = [
        RepositoryCaseResult.model_validate(
            {
                "case_id": case_id,
                "disposition": "keep",
                "review_record": {
                    "mitigation": {
                        "file_changes": [
                            {"path": f"{case_id}.py", "status": "deleted"}
                        ],
                        "patch_diff": "reference patch",
                    }
                },
            }
        )
        for entry in deliveries
        for case_id in entry.case_ids
    ]
    execution = build_delivery_execution_input(
        run_artifacts_root=tmp_path,
        workspace_snapshot_tar_path=tmp_path / "baseline.tar",
        deliveries=deliveries,
        keep_case_results=[
            project_repository_case_result_for_delivery(case) for case in cases
        ],
    )
    plan = DeliveryPlan.model_validate(
        {
            "status": "completed",
            "metadata": {
                "planning_mode": "single",
                "planning_pass_count": 1,
                "batch_size": None,
            },
            "counts": {
                "input_case_count": len(cases),
                "delivery_count": len(deliveries),
            },
            "deliveries": deliveries,
        }
    )
    started = [asyncio.Event() for _ in range(3)]
    release = [asyncio.Event() for _ in range(3)]

    @activity.defn(name="plan_repository_delivery_activity")
    async def planning(
        _request: ReviewWorkflowRequest, _cases: list[RepositoryCaseResult]
    ) -> DeliveryPlan:
        return plan

    @activity.defn(name="prepare_repository_delivery_execution_activity")
    async def preparing(
        _request: ReviewWorkflowRequest,
        _cases: list[RepositoryCaseResult],
        _plan: DeliveryPlan,
    ) -> DeliveryExecutionInput:
        return execution

    @activity.defn(name="execute_repository_combined_delivery_activity")
    async def synthesis(
        _request: ReviewWorkflowRequest,
        _execution: DeliveryExecutionInput,
        item: DeliveryExecutionItem,
    ) -> DeliveryExecutionResult:
        index = int(item.delivery.delivery_id.split("-")[1])
        started[index].set()
        await release[index].wait()
        return DeliveryExecutionResult(
            delivery_id=item.delivery.delivery_id,
            status="failed" if index == 1 else "ready",
            error="Synthesis failed." if index == 1 else None,
            patch_diff="combined patch",
            file_changes=(
                []
                if index == 1
                else [{"path": f"combined-{index}.py", "status": "deleted"}]
            ),
        )

    with ThreadPoolExecutor(max_workers=1) as executor:
        async with (
            temporal_time_skipping_environment() as env,
            Worker(
                env.client,
                activity_executor=executor,
                task_queue="delivery-window-replay",
                workflows=[RepositoryDeliveryWorkflow],
                activities=[
                    planning,
                    preparing,
                    synthesis,
                    execute_repository_single_deliveries_activity,
                    build_repository_delivery_result_activity,
                ],
            ),
        ):
            handle = await env.client.start_workflow(
                RepositoryDeliveryWorkflow.run,
                args=[
                    ReviewWorkflowRequest(
                        workflow="repository-review",
                        run_id="delivery-window-replay",
                        prepared_input=prepared_repository_input(
                            artifact_root_path=str(tmp_path)
                        ),
                        timeout_seconds=30,
                        runtime_context={},
                    ),
                    cases,
                ],
                id="delivery-window-replay",
                task_queue="delivery-window-replay",
            )
            try:
                await asyncio.wait_for(started[0].wait(), timeout=5)
                await asyncio.wait_for(started[1].wait(), timeout=5)
                release[1].set()
                await asyncio.wait_for(started[2].wait(), timeout=5)
                assert not release[0].is_set()
                release[2].set()
                release[0].set()
                result = await asyncio.wait_for(handle.result(), timeout=10)
                assert [item.delivery_id for item in result.deliveries] == [
                    "single",
                    "combined-0",
                    "combined-2",
                ]
                await Replayer(
                    workflows=[RepositoryDeliveryWorkflow],
                    data_converter=env.client.data_converter,
                ).replay_workflow(await handle.fetch_history())
            finally:
                for event in release:
                    event.set()
