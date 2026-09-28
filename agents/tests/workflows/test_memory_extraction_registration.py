import pytest

from sec_review_agents.memory.extraction_workflow import (
    MemoryExtractionRegistrationRequest,
    register_memory_extraction,
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
    calls: list[MemoryExtractionRegistrationRequest] = []

    async def fake_register(registration, *, enabled):
        assert enabled is True
        calls.append(registration)

    async def fake_execute_activity(activity_fn, *args, timeout_seconds):
        if activity_fn is issue_workflow.build_issue_review_result_activity:
            return {"contract_version": "v4"}
        return {}

    monkeypatch.setattr(
        issue_workflow,
        "register_memory_extraction",
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
    assert calls[0].job_id == "issue-review-run-1"


@pytest.mark.asyncio
async def test_pull_request_review_registers_memory_extraction_via_activity(
    monkeypatch,
) -> None:
    calls: list[MemoryExtractionRegistrationRequest] = []

    async def fake_register(registration, *, enabled):
        assert enabled is True
        calls.append(registration)

    async def fake_execute_activity(activity_fn, *args, timeout_seconds):
        if activity_fn is pr_workflow.build_pull_request_review_result_activity:
            return {"contract_version": "v4"}
        return {}

    monkeypatch.setattr(
        pr_workflow,
        "register_memory_extraction",
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
    assert calls[0].job_id == "pull-request-review-run-1"


@pytest.mark.asyncio
async def test_repository_review_does_not_register_run_level_memory_extraction(
    monkeypatch,
) -> None:
    async def fake_execute_activity(activity_fn, *args, timeout_seconds):
        if activity_fn is repository_workflow.build_repository_review_result_activity:
            return {"contract_version": "v4"}
        return {}

    async def fake_execute_child_workflow(*_args, **_kwargs):
        return {}

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


@pytest.mark.asyncio
async def test_register_memory_extraction_skips_disabled_request(
    monkeypatch,
) -> None:
    registration = MemoryExtractionRegistrationRequest(
        job_id="repository-review-run-1-case-7",
        source_workflow="repository-review",
        run_id="run-1",
        artifact_root_path="/tmp/run-1/artifacts/cases/case-7",
        timeout_seconds=30,
    )

    async def fake_execute_activity(*_args, **_kwargs):
        raise AssertionError("disabled case should not register memory extraction")

    monkeypatch.setattr(
        "sec_review_agents.memory.extraction_workflow.workflow.execute_activity",
        fake_execute_activity,
    )

    await register_memory_extraction(registration, enabled=False)


@pytest.mark.asyncio
async def test_repository_case_registers_memory_only_after_result_is_built(
    monkeypatch,
) -> None:
    """A failed case must not publish an incomplete transcript for learning."""
    events: list[str] = []
    prepared_case = {
        "case_execution_input": {"case_id": "case-7"},
        "artifact_paths": {},
        "transcript_thread_path": "unused",
    }

    async def fake_execute_activity(activity_fn, *args, **_kwargs):
        if activity_fn is repository_workflow.prepare_repository_case_activity:
            return prepared_case
        if activity_fn is repository_workflow.analyze_repository_case_activity:
            return {"verdict": "no-actionable-finding"}
        if activity_fn is repository_workflow.score_repository_case_cvss_activity:
            return None
        if activity_fn is repository_workflow.mitigate_repository_case_activity:
            return {"changed_files": []}
        if activity_fn is repository_workflow.verify_repository_case_activity:
            return {"patch_coverage": "no-patch"}
        if activity_fn is repository_workflow.build_repository_case_result_activity:
            events.append("result")
            return {"case_id": "case-7", "disposition": "drop"}
        raise AssertionError(f"Unexpected activity: {activity_fn}")

    registrations: list[MemoryExtractionRegistrationRequest] = []

    async def fake_register(registration, *, enabled):
        assert enabled is True
        registrations.append(registration)
        events.append("register")

    monkeypatch.setattr(
        repository_workflow.workflow,
        "execute_activity",
        fake_execute_activity,
    )
    monkeypatch.setattr(
        repository_workflow,
        "register_memory_extraction",
        fake_register,
    )
    monkeypatch.setattr(
        repository_workflow,
        "should_retry_from_verifier_result",
        lambda *_args: False,
    )
    request: repository_workflow.RepositoryCaseReviewRequest = {
        "run_id": "run-1",
        "case_execution_input": {
            "case_id": "case-7",
            "review_input": "Prepared case input.",
            "workspace_snapshot_tar_path": "/tmp/workspace.tar",
            "history_path": "/tmp/history",
            "scan_mode": "full",
            "incremental_window_path": None,
            "repair_mode": "test-changes-allowed",
        },
        "cases_artifacts_path": "/tmp/run-1/artifacts/cases",
        "transcript_thread_path": "unused",
        "timeout_seconds": 30,
        "runtime_context": {},
        "memory_extraction_registration_enabled": True,
    }

    result = await repository_workflow.RepositoryCaseReviewWorkflow().run(request)

    assert result == {"case_id": "case-7", "disposition": "drop"}
    assert events == ["result", "register"]
    assert registrations == [
        MemoryExtractionRegistrationRequest(
            job_id="repository-review-run-1-case-7",
            source_workflow="repository-review",
            run_id="run-1",
            artifact_root_path="/tmp/run-1/artifacts/cases/case-7",
            timeout_seconds=30,
        )
    ]


@pytest.mark.asyncio
async def test_register_memory_extraction_swallows_activity_failure(
    monkeypatch,
) -> None:
    registration = MemoryExtractionRegistrationRequest(
        job_id="issue-review-run-1",
        source_workflow="issue-review",
        run_id="run-1",
        artifact_root_path="/tmp/run-1/artifacts",
        timeout_seconds=30,
    )
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

    await register_memory_extraction(registration, enabled=True)

    assert warnings == [
        (
            "Failed to register memory extraction job for %s: %s",
            "temporary ledger failure",
        )
    ]


@pytest.mark.asyncio
async def test_issue_review_passes_disabled_registration_setting(
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

    calls: list[bool] = []

    async def fake_register(_registration, *, enabled):
        calls.append(enabled)

    monkeypatch.setattr(
        issue_workflow,
        "register_memory_extraction",
        fake_register,
    )

    async def fake_execute_activity(activity_fn, *args, **kwargs):
        if activity_fn is issue_workflow.build_issue_review_result_activity:
            return {"contract_version": "v4"}
        return {}

    monkeypatch.setattr(issue_workflow, "execute_activity", fake_execute_activity)

    await issue_workflow.IssueReviewWorkflow().run(request)

    assert calls == [False]
