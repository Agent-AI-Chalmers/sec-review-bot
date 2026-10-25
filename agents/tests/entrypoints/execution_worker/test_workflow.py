import pytest
from temporalio import workflow
from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner

from sec_review_agents.entrypoints.execution_contract import ExecutionRequest
from sec_review_agents.entrypoints.execution_worker import (
    workflow as execution_workflow,
)


@pytest.mark.asyncio
async def test_execution_workflow_can_be_prepared_in_temporal_sandbox() -> None:
    """Protect worker startup from restricted work performed during imports."""
    definition = workflow._Definition.must_from_class(
        execution_workflow.ExecutionWorkflow
    )

    SandboxedWorkflowRunner().prepare_workflow(definition)


@pytest.mark.asyncio
async def test_managed_execution_requires_managed_diagnostic_publication(
    monkeypatch,
) -> None:
    captured = []

    async def fake_execute_activity(*_args, **_kwargs):
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
        return {"ok": True, "result": {}}

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
        ExecutionRequest("issue-review", "run-1", {}, 30)
    )

    assert captured[0].post_processing.diagnostic_publication == "managed"
