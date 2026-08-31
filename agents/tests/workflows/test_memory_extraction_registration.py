import pytest

from sec_review_agents.memory.extraction_workflow import (
    register_memory_extraction_for_review,
)
from sec_review_agents.workflows.execution_request import InternalWorkflowRequest
from sec_review_agents.workflows.issue import workflow as issue_workflow
from sec_review_agents.workflows.pull_request import workflow as pr_workflow
from sec_review_agents.workflows.repository import workflow as repository_workflow


def test_internal_workflow_request_enables_memory_extraction_registration_by_default() -> (
    None
):
    request = InternalWorkflowRequest(
        workflow="issue-review",
        run_id="run-1",
        prepared_input={},
        timeout_seconds=30,
        runtime_context={},
    )

    assert request.memory_extraction_registration_enabled is True


@pytest.mark.asyncio
async def test_issue_review_registers_memory_extraction_via_activity(
    monkeypatch,
) -> None:
    calls: list[InternalWorkflowRequest] = []

    async def fake_register(request):
        calls.append(request)

    async def fake_execute_activity(activity_fn, *args, timeout_seconds):
        if activity_fn is issue_workflow.build_issue_review_result_activity:
            return {"contract_version": "v4"}
        return {}

    monkeypatch.setattr(
        issue_workflow,
        "register_memory_extraction_for_review",
        fake_register,
    )
    monkeypatch.setattr(issue_workflow, "execute_activity", fake_execute_activity)

    request = InternalWorkflowRequest(
        workflow="issue-review",
        run_id="run-1",
        prepared_input={"artifact_root_path": "/tmp/run-1/artifacts"},
        timeout_seconds=30,
        runtime_context={},
    )
    result = await issue_workflow.IssueReviewWorkflow().run(request)

    assert result == {"ok": True, "result": {"contract_version": "v4"}}
    assert len(calls) == 1
    assert calls[0].workflow == "issue-review"


@pytest.mark.asyncio
async def test_pull_request_review_registers_memory_extraction_via_activity(
    monkeypatch,
) -> None:
    calls: list[InternalWorkflowRequest] = []

    async def fake_register(request):
        calls.append(request)

    async def fake_execute_activity(activity_fn, *args, timeout_seconds):
        if activity_fn is pr_workflow.build_pull_request_review_result_activity:
            return {"contract_version": "v4"}
        return {}

    monkeypatch.setattr(
        pr_workflow,
        "register_memory_extraction_for_review",
        fake_register,
    )
    monkeypatch.setattr(pr_workflow, "execute_activity", fake_execute_activity)

    request = InternalWorkflowRequest(
        workflow="pull-request-review",
        run_id="run-1",
        prepared_input={"artifact_root_path": "/tmp/run-1/artifacts"},
        timeout_seconds=30,
        runtime_context={},
    )
    result = await pr_workflow.PullRequestReviewWorkflow().run(request)

    assert result == {"ok": True, "result": {"contract_version": "v4"}}
    assert len(calls) == 1
    assert calls[0].workflow == "pull-request-review"


@pytest.mark.asyncio
async def test_repository_review_registers_memory_extraction_via_activity(
    monkeypatch,
) -> None:
    calls: list[InternalWorkflowRequest] = []

    async def fake_register(request):
        calls.append(request)

    async def fake_execute_activity(activity_fn, *args, timeout_seconds):
        if activity_fn is repository_workflow.build_repository_review_result_activity:
            return {"contract_version": "v4"}
        return {}

    async def fake_execute_child_workflow(*_args, **_kwargs):
        return {}

    monkeypatch.setattr(
        repository_workflow,
        "register_memory_extraction_for_review",
        fake_register,
    )
    monkeypatch.setattr(
        repository_workflow,
        "execute_activity",
        fake_execute_activity,
    )
    monkeypatch.setattr(
        repository_workflow.workflow,
        "execute_child_workflow",
        fake_execute_child_workflow,
    )

    request = InternalWorkflowRequest(
        workflow="repository-review",
        run_id="run-1",
        prepared_input={"artifact_root_path": "/tmp/run-1/artifacts"},
        timeout_seconds=30,
        runtime_context={},
    )
    result = await repository_workflow.RepositoryReviewWorkflow().run(request)

    assert result == {"ok": True, "result": {"contract_version": "v4"}}
    assert len(calls) == 1
    assert calls[0].workflow == "repository-review"


@pytest.mark.asyncio
async def test_register_memory_extraction_for_review_swallows_activity_failure(
    monkeypatch,
) -> None:
    request = type(
        "Request",
        (),
        {
            "workflow": "issue-review",
            "run_id": "run-1",
            "timeout_seconds": 30,
            "prepared_input": {"artifact_root_path": "/tmp/run-1/artifacts"},
        },
    )()
    warnings: list[tuple[str, str]] = []

    async def fake_execute_activity(*_args, **_kwargs):
        raise RuntimeError("temporary ledger failure")

    class FakeLogger:
        def warning(self, message: str, run_id: str, error: Exception) -> None:
            warnings.append((message, str(error)))

    monkeypatch.setattr(
        "sec_review_agents.memory.extraction_workflow.workflow.execute_activity",
        fake_execute_activity,
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.extraction_workflow.workflow.logger",
        FakeLogger(),
    )

    await register_memory_extraction_for_review(request)

    assert warnings == [
        (
            "Failed to register memory extraction job for %s: %s",
            "temporary ledger failure",
        )
    ]


@pytest.mark.asyncio
async def test_register_memory_extraction_for_review_skips_disabled_request(
    monkeypatch,
) -> None:
    request = InternalWorkflowRequest(
        workflow="issue-review",
        run_id="run-1",
        prepared_input={"artifact_root_path": "/tmp/run-1/artifacts"},
        timeout_seconds=30,
        runtime_context={},
        memory_extraction_registration_enabled=False,
    )

    async def fake_execute_activity(*_args, **_kwargs):
        raise AssertionError("disabled request should not register memory extraction")

    monkeypatch.setattr(
        "sec_review_agents.memory.extraction_workflow.workflow.execute_activity",
        fake_execute_activity,
    )

    await register_memory_extraction_for_review(request)
