from typing import Any

import pytest
from temporalio import workflow
from temporalio.converter import DataConverter
from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner

from sec_review_agents.entrypoints.execution_protocol import EXECUTION_REQUEST_INVALID
from sec_review_agents.entrypoints.execution_worker import (
    workflow as execution_workflow,
)
from sec_review_agents.entrypoints.execution_workflow import ExecutionWorkflowInput
from tests.contract_fixtures import execution_workflow_fixture


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
    captured = []
    activity_calls = []

    async def fake_execute_activity(*args, **kwargs):
        activity_calls.append((args, kwargs))
        return {
            "ok": True,
            "workflow": "issue-review",
            "run_id": "run-1",
            "prepared_input": {"artifact_root_path": "/tmp/run-1/artifacts"},
            "runtime_context": {},
            "timeout_seconds": 30,
            "memory_processing_enabled": True,
        }

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
    assert captured[0].post_processing.diagnostic_scheme == "s3"


@pytest.mark.parametrize(
    "fixture_name",
    ["invalid-extra-top-level-field.json", "invalid-missing-timeout.json"],
)
def test_preparation_activity_rejects_raw_payload_shape(fixture_name: str) -> None:
    result = execution_workflow.prepare_execution_run_activity(
        execution_workflow_fixture(fixture_name)
    )

    assert result["ok"] is False
    assert result["error"]["code"] == EXECUTION_REQUEST_INVALID
