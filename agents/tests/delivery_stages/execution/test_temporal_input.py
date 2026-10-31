import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError
from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Worker

from sec_review_agents.delivery_stages.execution.input import (
    DeliveryExecutionInput,
    DeliveryPatchCase,
    build_delivery_execution_input,
)
from sec_review_agents.delivery_stages.execution.result import DeliveryExecutionResult
from sec_review_agents.delivery_stages.model import (
    DeliveryCaseInput,
    DeliveryEntry,
)
from sec_review_agents.workflows.repository.workflow import (
    build_repository_delivery_result_activity,
    execute_repository_combined_delivery_activity,
    execute_repository_single_deliveries_activity,
)
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest
from sec_review_agents.workspace.patches import PatchArtifact
from tests.prepared_input_fixtures import prepared_repository_input
from tests.temporal_test_utils import temporal_time_skipping_environment


def execution_input(tmp_path: Path) -> DeliveryExecutionInput:
    case: DeliveryCaseInput = DeliveryCaseInput(
        case_id="case-1",
        disposition="keep",
        reason=None,
        mitigation_overview="Patched",
        mitigator_file_changes=[
            {"path": "old.py", "status": "deleted"},
            {
                "path": "new.py",
                "status": "upsert",
                "content": "updated",
                "content_encoding": "utf-8",
                "mode": "100755",
            },
            {
                "path": "data.bin",
                "status": "upsert",
                "content": "AA==",
                "content_encoding": "base64",
            },
        ],
        mitigator_patch_diff="reference patch",
    )
    return build_delivery_execution_input(
        run_artifacts_root=tmp_path,
        workspace_snapshot_tar_path=tmp_path / "baseline.tar",
        deliveries=[
            DeliveryEntry(
                delivery_id="single",
                strategy="single",
                case_ids=["case-1"],
                reason="Independent patch",
            ),
            DeliveryEntry(
                delivery_id="combined",
                strategy="combined",
                case_ids=["case-1"],
                reason="Combined patch",
            ),
        ],
        keep_case_results=[case],
    )


@workflow.defn
class DeliveryInputProbeWorkflow:
    @workflow.run
    async def run(
        self, payload: DeliveryExecutionInput
    ) -> list[DeliveryExecutionResult]:
        request = ReviewWorkflowRequest(
            workflow="repository-review",
            run_id="delivery-input-probe",
            prepared_input=prepared_repository_input(),
            timeout_seconds=30,
            runtime_context={},
        )
        single = await workflow.execute_activity(
            execute_repository_single_deliveries_activity,
            args=[request, payload],
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )
        combined = await workflow.execute_activity(
            execute_repository_combined_delivery_activity,
            args=[request, payload, payload.combined_delivery_execution_items[0]],
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )
        assert combined is not None
        result = await workflow.execute_activity(
            build_repository_delivery_result_activity,
            args=[payload, [single[0], combined]],
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )
        assert result.status == "completed"
        assert [item.delivery_id for item in result.deliveries] == [
            "single",
            "combined",
        ]
        return [single[0], combined]


@pytest.mark.asyncio
async def test_delivery_input_uses_same_compact_patch_for_both_strategies(
    tmp_path: Path,
) -> None:
    payload = execution_input(tmp_path)
    expected = {
        "case_id": "case-1",
        "mitigator_file_changes": [
            {"path": "old.py", "status": "deleted"},
            {
                "path": "new.py",
                "status": "upsert",
                "content": "updated",
                "content_encoding": "utf-8",
                "mode": "100755",
            },
            {
                "path": "data.bin",
                "status": "upsert",
                "content": "AA==",
                "content_encoding": "base64",
            },
        ],
        "mitigator_patch_diff": "reference patch",
    }
    assert payload.single_delivery_execution_items[0].case_items == [
        DeliveryPatchCase.model_validate(expected)
    ]
    assert payload.combined_delivery_execution_items[0].case_items == [
        DeliveryPatchCase.model_validate(expected)
    ]
    converter = pydantic_data_converter
    assert await converter.decode(
        await converter.encode([payload]), [DeliveryExecutionInput]
    ) == [payload]
    malformed = {**payload.model_dump(), "max_concurrency": "not an integer"}
    with pytest.raises(ValidationError, match="max_concurrency"):
        await converter.decode(
            await converter.encode([malformed]), [DeliveryExecutionInput]
        )


@pytest.mark.asyncio
async def test_delivery_patch_input_crosses_real_temporal_activities(
    tmp_path: Path,
) -> None:
    """Keep execution imports outside the sandbox and preserve nested file changes."""
    payload = execution_input(tmp_path)
    synthesis = AsyncMock(
        return_value=PatchArtifact.model_validate(
            {
                "file_changes": [{"path": "old.py", "status": "deleted"}],
                "patch_diff": "combined patch",
            }
        )
    )
    with (
        ThreadPoolExecutor() as executor,
        patch(
            "sec_review_agents.delivery_stages.execution.stage.synthesize_combined_delivery_patch",
            synthesis,
        ),
    ):
        async with (
            temporal_time_skipping_environment() as env,
            Worker(
                env.client,
                task_queue="delivery-input-probe",
                activity_executor=executor,
                workflows=[DeliveryInputProbeWorkflow],
                activities=[
                    build_repository_delivery_result_activity,
                    execute_repository_single_deliveries_activity,
                    execute_repository_combined_delivery_activity,
                ],
            ),
        ):
            results = await asyncio.wait_for(
                env.client.execute_workflow(
                    DeliveryInputProbeWorkflow.run,
                    payload,
                    id="delivery-input-probe",
                    task_queue="delivery-input-probe",
                ),
                timeout=45,
            )
    assert [item.status for item in results] == ["ready", "ready"]
    assert [item.patch_diff for item in results] == [
        "reference patch",
        "combined patch",
    ]
    assert (
        synthesis.call_args.kwargs["case_items"]
        == payload.combined_delivery_execution_items[0].case_items
    )
