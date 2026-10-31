import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from temporalio import activity, workflow
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.converter import DataConverter
from temporalio.worker import Worker
from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner

from sec_review_agents.entrypoints.execution_protocol import EXECUTION_REQUEST_INVALID
from sec_review_agents.entrypoints.execution_worker import (
    workflow as execution_workflow,
)
from sec_review_agents.entrypoints.execution_workflow import ExecutionWorkflowInput
from sec_review_agents.workflows.review_request import (
    ReviewPostProcessingPolicy,
    ReviewWorkflowRequest,
)
from tests.contract_fixtures import execution_workflow_fixture
from tests.prepared_input_fixtures import prepared_issue_input
from tests.temporal_test_utils import temporal_time_skipping_environment


@pytest.mark.asyncio
async def test_execution_workflow_can_be_prepared_in_temporal_sandbox() -> None:
    """Protect worker startup from restricted work performed during imports."""
    definition = workflow._Definition.must_from_class(
        execution_workflow.ExecutionWorkflow
    )

    SandboxedWorkflowRunner().prepare_workflow(definition)


@pytest.mark.asyncio
async def test_temporal_conversion_preserves_raw_input_until_validation() -> None:
    raw_payload = {
        "workflow": "issue-review",
        "run_id": "run-1",
        "input": {},
        "timeout_seconds": 30,
        "unknown": True,
    }
    encoded_raw = await DataConverter.default.encode([raw_payload])

    decoded_raw = await DataConverter.default.decode(encoded_raw, [dict[str, Any]])

    assert decoded_raw == [raw_payload]

    normalized_payload = {
        "workflow": "issue-review",
        "run_id": "run-1",
        "input": {},
        "timeout_seconds": 30,
        "runtime": None,
    }
    encoded_normalized = await DataConverter.default.encode([normalized_payload])

    decoded_typed = await DataConverter.default.decode(
        encoded_normalized, [ExecutionWorkflowInput]
    )

    assert decoded_typed == [ExecutionWorkflowInput("issue-review", "run-1", {}, 30)]


@pytest.mark.asyncio
async def test_execution_gateway_runs_publish_diagnostics_to_s3(
    monkeypatch,
) -> None:
    prepared = ReviewWorkflowRequest(
        workflow="issue-review",
        run_id="run-1",
        prepared_input=prepared_issue_input(artifact_root_path="/tmp/run-1/artifacts"),
        runtime_context={},
        timeout_seconds=30,
        post_processing=ReviewPostProcessingPolicy(diagnostic_scheme="s3"),
    )
    captured = []
    activity_calls = []

    async def fake_execute_activity(*args, **kwargs):
        activity_calls.append((args, kwargs))
        return prepared

    async def fake_execute_child_workflow(*args, **_kwargs):
        captured.append(args[1])
        return {
            "ok": True,
            "result": {},
        }

    monkeypatch.setattr(
        execution_workflow.workflow,
        "execute_activity",
        fake_execute_activity,
    )
    monkeypatch.setattr(
        execution_workflow.workflow,
        "execute_child_workflow",
        fake_execute_child_workflow,
    )

    await execution_workflow.ExecutionWorkflow().run(
        {
            "workflow": "issue-review",
            "run_id": "run-1",
            "input": {},
            "timeout_seconds": 30,
        }
    )

    assert activity_calls[0][0][0] is execution_workflow.prepare_execution_run_activity
    assert (
        activity_calls[0][1]["schedule_to_close_timeout"]
        == execution_workflow.EXECUTION_INPUT_PREPARATION_TIMEOUT
    )
    assert captured[0] is prepared
    assert captured[0].post_processing.diagnostic_scheme == "s3"


@pytest.mark.parametrize(
    "fixture_name",
    ["invalid-extra-top-level-field.json", "invalid-missing-timeout.json"],
)
def test_preparation_activity_rejects_raw_payload_shape(fixture_name: str) -> None:
    result = execution_workflow.prepare_execution_run_activity(
        execution_workflow_fixture(fixture_name)
    )

    assert isinstance(result, execution_workflow.PreparationFailure)
    assert result.code == EXECUTION_REQUEST_INVALID


@pytest.mark.asyncio
@pytest.mark.parametrize("success", [True, False])
async def test_preparation_result_temporal_conversion(success: bool) -> None:
    result = (
        ReviewWorkflowRequest(
            workflow="issue-review",
            run_id="run-1",
            prepared_input=prepared_issue_input(artifact_root_path="/tmp/artifacts"),
            timeout_seconds=30,
            runtime_context={"workspace_image": "review:latest"},
            post_processing=ReviewPostProcessingPolicy(
                memory_processing_enabled=False, diagnostic_scheme="s3"
            ),
        )
        if success
        else execution_workflow.prepare_execution_run_activity(
            execution_workflow_fixture("invalid-extra-top-level-field.json")
        )
    )
    definition = activity._Definition.must_from_callable(
        execution_workflow.prepare_execution_run_activity
    )
    assert definition.ret_type is not None
    restored = (
        await pydantic_data_converter.decode(
            await pydantic_data_converter.encode([result]), [definition.ret_type]
        )
    )[0]
    assert type(restored) is type(result)
    assert restored == result


@pytest.mark.asyncio
async def test_preparation_failure_crosses_real_temporal_workflow() -> None:
    raw = execution_workflow_fixture("invalid-extra-top-level-field.json")
    expected = execution_workflow.prepare_execution_run_activity(raw)
    assert isinstance(expected, execution_workflow.PreparationFailure)
    async with temporal_time_skipping_environment() as env:
        with ThreadPoolExecutor(max_workers=1) as executor:
            async with Worker(
                env.client,
                task_queue="execution-preparation-failure",
                workflows=[execution_workflow.ExecutionWorkflow],
                activities=[execution_workflow.prepare_execution_run_activity],
                activity_executor=executor,
            ):
                result = await asyncio.wait_for(
                    env.client.execute_workflow(
                        execution_workflow.ExecutionWorkflow.run,
                        raw,
                        id="execution-preparation-failure",
                        task_queue="execution-preparation-failure",
                    ),
                    timeout=30,
                )
    assert result == {
        "ok": False,
        "error": {
            "code": EXECUTION_REQUEST_INVALID,
            "category": "input",
            "message": expected.message,
            "details": {"name": "ValueError"},
            "retryable": False,
        },
    }


@pytest.mark.parametrize("memory_enabled", [True, False])
def test_preparation_builds_production_review_request(monkeypatch, memory_enabled):
    from sec_review_agents import features
    from sec_review_agents.entrypoints import input_preparation

    prepared_input = prepared_issue_input(artifact_root_path="/tmp/run-1/artifacts")
    monkeypatch.setattr(
        input_preparation, "prepare_run_input", lambda *a, **k: prepared_input
    )
    monkeypatch.setattr(features, "memory_processing_enabled", lambda: memory_enabled)
    result = execution_workflow.prepare_execution_run_activity(
        {
            "workflow": "issue-review",
            "run_id": "run-1",
            "input": {},
            "timeout_seconds": 30,
        }
    )
    assert isinstance(result, ReviewWorkflowRequest)
    assert result.prepared_input is prepared_input
    assert result.post_processing == ReviewPostProcessingPolicy(
        memory_processing_enabled=memory_enabled, diagnostic_scheme="s3"
    )


@workflow.defn(name="IssueReviewWorkflow", sandboxed=False)
class PreparedRequestProbe:
    @workflow.run
    async def run(self, request: ReviewWorkflowRequest) -> dict[str, Any]:
        return {
            "ok": True,
            "run_id": request.run_id,
            "prepared_input": request.prepared_input.model_dump(mode="json"),
            "prepared_type": type(request.prepared_input).__name__,
            "diagnostic_scheme": request.post_processing.diagnostic_scheme,
            "memory_processing_enabled": request.post_processing.memory_processing_enabled,
        }


@pytest.mark.asyncio
async def test_prepared_request_reaches_child_through_real_temporal(
    monkeypatch,
) -> None:
    from sec_review_agents import features
    from sec_review_agents.entrypoints import input_preparation

    monkeypatch.setattr(
        input_preparation,
        "prepare_run_input",
        lambda *a, **k: prepared_issue_input(artifact_root_path="/tmp/run-1/artifacts"),
    )
    monkeypatch.setattr(features, "memory_processing_enabled", lambda: False)
    async with temporal_time_skipping_environment() as env:
        with ThreadPoolExecutor(max_workers=1) as executor:
            async with Worker(
                env.client,
                task_queue="execution-preparation-success",
                workflows=[execution_workflow.ExecutionWorkflow, PreparedRequestProbe],
                activities=[execution_workflow.prepare_execution_run_activity],
                activity_executor=executor,
            ):
                result = await asyncio.wait_for(
                    env.client.execute_workflow(
                        execution_workflow.ExecutionWorkflow.run,
                        {
                            "workflow": "issue-review",
                            "run_id": "run-1",
                            "input": {},
                            "timeout_seconds": 30,
                        },
                        id="execution-preparation-success",
                        task_queue="execution-preparation-success",
                    ),
                    timeout=30,
                )
    assert result == {
        "ok": True,
        "run_id": "run-1",
        "prepared_input": prepared_issue_input(
            artifact_root_path="/tmp/run-1/artifacts"
        ).model_dump(mode="json"),
        "prepared_type": "PreparedIssueInput",
        "diagnostic_scheme": "s3",
        "memory_processing_enabled": False,
    }
