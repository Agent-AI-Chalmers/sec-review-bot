import pytest

from sec_review_agents.entrypoints.contract_schema import CONTRACT_VERSION
from sec_review_agents.memory.extraction_workflow import (
    TranscriptBundlePublicationRequest,
)
from sec_review_agents.workflows.execution_request import InternalWorkflowRequest
from sec_review_agents.workflows.issue import workflow as issue_workflow
from sec_review_agents.workflows.pull_request import workflow as pr_workflow
from sec_review_agents.workflows.repository import workflow as repository_workflow


def test_internal_workflow_request_enables_memory_extraction_by_default() -> None:
    request = InternalWorkflowRequest(
        workflow="issue-review",
        run_id="run-1",
        prepared_input={},
        timeout_seconds=30,
        runtime_context={},
    )

    assert request.memory_extraction_enabled is True


@pytest.mark.asyncio
async def test_issue_review_publishes_transcripts_and_starts_memory(
    monkeypatch,
) -> None:
    calls: list[tuple[TranscriptBundlePublicationRequest, str, bool]] = []

    async def fake_publish(request, *, source_workflow, start_extractions):
        calls.append((request, source_workflow, start_extractions))
        return {"transcript_publication": "published", "extractions": []}

    async def fake_execute_activity(activity_fn, *args, timeout_seconds):
        if activity_fn is issue_workflow.build_issue_review_result_activity:
            return {"contract_version": CONTRACT_VERSION}
        return {}

    monkeypatch.setattr(
        issue_workflow,
        "publish_and_start_memory_extractions",
        fake_publish,
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

    assert result["result"] == {"contract_version": CONTRACT_VERSION}
    assert result["memory_processing"]["transcript_publication"] == "published"
    assert len(calls) == 1
    publication, source_workflow, start_extractions = calls[0]
    assert publication.review_units == [
        {
            "review_unit_id": "review",
            "transcript_root": "/tmp/run-1/artifacts/transcripts",
        }
    ]
    assert source_workflow == "issue-review"
    assert start_extractions is True


@pytest.mark.asyncio
async def test_pull_request_review_publishes_transcripts_and_starts_memory(
    monkeypatch,
) -> None:
    calls: list[tuple[TranscriptBundlePublicationRequest, str, bool]] = []

    async def fake_publish(request, *, source_workflow, start_extractions):
        calls.append((request, source_workflow, start_extractions))
        return {"transcript_publication": "published", "extractions": []}

    async def fake_execute_activity(activity_fn, *args, timeout_seconds):
        if activity_fn is pr_workflow.build_pull_request_review_result_activity:
            return {"contract_version": CONTRACT_VERSION}
        return {}

    monkeypatch.setattr(
        pr_workflow,
        "publish_and_start_memory_extractions",
        fake_publish,
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

    assert result["result"] == {"contract_version": CONTRACT_VERSION}
    assert len(calls) == 1
    assert calls[0][0].review_units[0]["review_unit_id"] == "review"
    assert calls[0][1:] == ("pull-request-review", True)


@pytest.mark.asyncio
async def test_repository_review_without_cases_does_not_publish_empty_bundle(
    monkeypatch,
) -> None:
    async def fake_execute_activity(activity_fn, *args, timeout_seconds):
        if activity_fn is repository_workflow.build_repository_review_result_activity:
            return {"contract_version": CONTRACT_VERSION}
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

    assert result == {
        "ok": True,
        "result": {"contract_version": CONTRACT_VERSION},
        "memory_processing": None,
    }


@pytest.mark.asyncio
async def test_repository_review_publishes_all_case_units_once(monkeypatch) -> None:
    publications: list[tuple[TranscriptBundlePublicationRequest, str, bool]] = []
    child_results = iter(
        [
            {"scan": "done"},
            [
                {"case_id": "case-a", "disposition": "keep"},
                {"case_id": "case-b", "disposition": "drop"},
            ],
            {"delivery": "done"},
        ]
    )

    async def fake_execute_activity(activity_fn, *args, timeout_seconds):
        if activity_fn is repository_workflow.build_repository_review_result_activity:
            return {"contract_version": CONTRACT_VERSION}
        return {}

    async def fake_execute_child_workflow(*_args, **_kwargs):
        return next(child_results)

    async def fake_publish(request, *, source_workflow, start_extractions):
        publications.append((request, source_workflow, start_extractions))
        return {"transcript_publication": "published", "extractions": []}

    monkeypatch.setattr(repository_workflow, "execute_activity", fake_execute_activity)
    monkeypatch.setattr(
        repository_workflow.workflow,
        "execute_child_workflow",
        fake_execute_child_workflow,
    )
    monkeypatch.setattr(
        repository_workflow,
        "publish_and_start_memory_extractions",
        fake_publish,
    )

    request = InternalWorkflowRequest(
        workflow="repository-review",
        run_id="run-1",
        prepared_input={"artifact_root_path": "/tmp/run-1/artifacts"},
        timeout_seconds=30,
        runtime_context={},
    )
    result = await repository_workflow.RepositoryReviewWorkflow().run(request)

    assert result["result"] == {"contract_version": CONTRACT_VERSION}
    assert len(publications) == 1
    publication, source_workflow, start_extractions = publications[0]
    assert publication.review_units == [
        {
            "review_unit_id": "case-a",
            "transcript_root": "/tmp/run-1/artifacts/cases/case-a/transcripts",
        },
        {
            "review_unit_id": "case-b",
            "transcript_root": "/tmp/run-1/artifacts/cases/case-b/transcripts",
        },
    ]
    assert source_workflow == "repository-review"
    assert start_extractions is True


@pytest.mark.asyncio
async def test_repository_case_does_not_publish_before_parent_run_finishes(
    monkeypatch,
) -> None:
    """A failed case must not publish an incomplete transcript for learning."""
    events: list[str] = []
    prepared_case = {
        "case_execution_input": {"case_id": "case-7"},
        "artifact_paths": {},
        "published_transcripts_path": "unused",
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

    monkeypatch.setattr(
        repository_workflow.workflow,
        "execute_activity",
        fake_execute_activity,
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
            "test_changes": "allow",
        },
        "cases_artifacts_path": "/tmp/run-1/artifacts/cases",
        "published_transcripts_path": "unused",
        "timeout_seconds": 30,
        "runtime_context": {},
    }

    result = await repository_workflow.RepositoryCaseReviewWorkflow().run(request)

    assert result == {"case_id": "case-7", "disposition": "drop"}
    assert events == ["result"]


@pytest.mark.asyncio
async def test_issue_review_still_publishes_when_memory_extraction_is_disabled(
    monkeypatch,
) -> None:
    request = InternalWorkflowRequest(
        workflow="issue-review",
        run_id="run-1",
        prepared_input={"artifact_root_path": "/tmp/run-1/artifacts"},
        timeout_seconds=30,
        runtime_context={},
        memory_extraction_enabled=False,
    )

    calls: list[bool] = []

    async def fake_publish(_request, *, source_workflow, start_extractions):
        assert source_workflow == "issue-review"
        calls.append(start_extractions)
        return {"transcript_publication": "published", "extractions": []}

    monkeypatch.setattr(
        issue_workflow,
        "publish_and_start_memory_extractions",
        fake_publish,
    )

    async def fake_execute_activity(activity_fn, *args, **kwargs):
        if activity_fn is issue_workflow.build_issue_review_result_activity:
            return {"contract_version": CONTRACT_VERSION}
        return {}

    monkeypatch.setattr(issue_workflow, "execute_activity", fake_execute_activity)

    await issue_workflow.IssueReviewWorkflow().run(request)

    assert calls == [False]
