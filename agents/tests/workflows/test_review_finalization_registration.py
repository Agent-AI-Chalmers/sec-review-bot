import pytest

from sec_review_agents.entrypoints.contract_schema import CONTRACT_VERSION
from sec_review_agents.workflows.issue import workflow as issue_workflow
from sec_review_agents.workflows.pull_request import workflow as pr_workflow
from sec_review_agents.workflows.repository import workflow as repository_workflow
from sec_review_agents.workflows.review_finalization import (
    RunDiagnosticPublicationRequest,
)
from sec_review_agents.workflows.review_request import (
    ReviewPostProcessingPolicy,
    ReviewWorkflowRequest,
)


def _finalized(*review_unit_ids: str) -> dict[str, object]:
    return {
        "diagnostic_bundle": {
            "uri": "s3://sec-review/runs/run-1/artifacts/diagnostic-tree.v1.tar.zst",
            "digest": f"sha256:{'a' * 64}",
            "media_type": "application/tar+zstd",
            "size_bytes": 42,
        },
        "artifact_storage": {
            "status": "available",
            "artifact": {
                "kind": "diagnostic_bundle",
                "uri": "s3://sec-review/runs/run-1/artifacts/diagnostic-tree.v1.tar.zst",
                "digest": f"sha256:{'a' * 64}",
                "media_type": "application/tar+zstd",
                "size_bytes": 42,
            },
        },
        "review_unit_ids": list(review_unit_ids),
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("workflow_module", "workflow_class", "workflow_name"),
    [
        (issue_workflow, issue_workflow.IssueReviewWorkflow, "issue-review"),
        (pr_workflow, pr_workflow.PullRequestReviewWorkflow, "pull-request-review"),
    ],
)
async def test_single_review_finalizes_before_scheduling_memory(
    monkeypatch,
    workflow_module,
    workflow_class,
    workflow_name,
) -> None:
    events: list[str] = []
    publications: list[RunDiagnosticPublicationRequest] = []

    async def fake_execute_activity(activity_fn, *args, **_kwargs):
        if activity_fn.__name__.startswith("build_"):
            return {"contract_version": CONTRACT_VERSION}
        return {}

    async def fake_finalize(request):
        events.append("finalize")
        publications.append(request)
        return _finalized("review")

    async def fake_schedule(**kwargs):
        events.append("schedule")
        assert kwargs["review_unit_ids"] == ["review"]
        return {"extractions": []}

    monkeypatch.setattr(workflow_module, "execute_activity", fake_execute_activity)
    monkeypatch.setattr(workflow_module, "finalize_review_run", fake_finalize)
    monkeypatch.setattr(workflow_module, "schedule_memory_extractions", fake_schedule)

    result = await workflow_class().run(
        ReviewWorkflowRequest(
            workflow=workflow_name,
            run_id="run-1",
            prepared_input={"artifact_root_path": "/tmp/run-1/artifacts"},
            timeout_seconds=30,
            runtime_context={},
        )
    )

    assert result["result"] == {"contract_version": CONTRACT_VERSION}
    assert events == ["finalize", "schedule"]
    assert publications[0].review_units == [
        {
            "review_unit_id": "review",
            "transcript_root": "/tmp/run-1/artifacts/transcripts",
        }
    ]


@pytest.mark.asyncio
async def test_repository_finalizes_one_run_bundle_with_case_units(
    monkeypatch,
) -> None:
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
    publications: list[RunDiagnosticPublicationRequest] = []

    async def fake_execute_activity(activity_fn, *args, **_kwargs):
        if activity_fn is repository_workflow.build_repository_review_result_activity:
            return {"contract_version": CONTRACT_VERSION}
        return {}

    async def fake_execute_child_workflow(*_args, **_kwargs):
        return next(child_results)

    async def fake_finalize(request):
        publications.append(request)
        return _finalized("case-a", "case-b")

    async def fake_schedule(**kwargs):
        assert kwargs["review_unit_ids"] == ["case-a", "case-b"]
        return {"extractions": []}

    monkeypatch.setattr(repository_workflow, "execute_activity", fake_execute_activity)
    monkeypatch.setattr(
        repository_workflow.workflow,
        "execute_child_workflow",
        fake_execute_child_workflow,
    )
    monkeypatch.setattr(repository_workflow, "finalize_review_run", fake_finalize)
    monkeypatch.setattr(
        repository_workflow, "schedule_memory_extractions", fake_schedule
    )

    await repository_workflow.RepositoryReviewWorkflow().run(
        ReviewWorkflowRequest(
            workflow="repository-review",
            run_id="run-1",
            prepared_input={"artifact_root_path": "/tmp/run-1/artifacts"},
            timeout_seconds=30,
            runtime_context={},
        )
    )

    assert len(publications) == 1
    assert publications[0].review_units == [
        {
            "review_unit_id": "case-a",
            "transcript_root": "/tmp/run-1/artifacts/cases/case-a/transcripts",
        },
        {
            "review_unit_id": "case-b",
            "transcript_root": "/tmp/run-1/artifacts/cases/case-b/transcripts",
        },
    ]


@pytest.mark.asyncio
async def test_repository_without_cases_still_publishes_run_diagnostic(
    monkeypatch,
) -> None:
    async def fake_execute_activity(activity_fn, *args, **_kwargs):
        if activity_fn is repository_workflow.build_repository_review_result_activity:
            return {"contract_version": CONTRACT_VERSION}
        return {}

    async def fake_execute_child_workflow(*_args, **_kwargs):
        return {}

    publications = []

    async def fake_finalize(request):
        publications.append(request)
        return _finalized()

    monkeypatch.setattr(repository_workflow, "execute_activity", fake_execute_activity)
    monkeypatch.setattr(
        repository_workflow.workflow,
        "execute_child_workflow",
        fake_execute_child_workflow,
    )
    monkeypatch.setattr(repository_workflow, "finalize_review_run", fake_finalize)

    result = await repository_workflow.RepositoryReviewWorkflow().run(
        ReviewWorkflowRequest(
            workflow="repository-review",
            run_id="run-1",
            prepared_input={"artifact_root_path": "/tmp/run-1/artifacts"},
            timeout_seconds=30,
            runtime_context={},
        )
    )

    assert result["memory_processing"] is None
    assert len(publications) == 1
    assert publications[0].review_units == []


@pytest.mark.asyncio
async def test_disabling_memory_does_not_skip_review_finalization(monkeypatch) -> None:
    events: list[str] = []

    async def fake_execute_activity(activity_fn, *args, **_kwargs):
        if activity_fn is issue_workflow.build_issue_review_result_activity:
            return {"contract_version": CONTRACT_VERSION}
        return {}

    async def fake_finalize(_request):
        events.append("finalize")
        return _finalized("review")

    async def fake_schedule(**kwargs):
        events.append("schedule")
        assert kwargs["enabled"] is False
        return {"extractions": []}

    monkeypatch.setattr(issue_workflow, "execute_activity", fake_execute_activity)
    monkeypatch.setattr(issue_workflow, "finalize_review_run", fake_finalize)
    monkeypatch.setattr(issue_workflow, "schedule_memory_extractions", fake_schedule)

    await issue_workflow.IssueReviewWorkflow().run(
        ReviewWorkflowRequest(
            workflow="issue-review",
            run_id="run-1",
            prepared_input={"artifact_root_path": "/tmp/run-1/artifacts"},
            timeout_seconds=30,
            runtime_context={},
            post_processing=ReviewPostProcessingPolicy(memory_processing_enabled=False),
        )
    )

    assert events == ["finalize", "schedule"]


@pytest.mark.asyncio
async def test_publication_failure_fails_review_before_memory_scheduling(
    monkeypatch,
) -> None:
    async def fake_execute_activity(activity_fn, *args, **_kwargs):
        if activity_fn is issue_workflow.build_issue_review_result_activity:
            return {"contract_version": CONTRACT_VERSION}
        return {}

    async def fail_finalization(_request):
        raise RuntimeError("storage unavailable")

    async def unexpected_schedule(**_kwargs):
        raise AssertionError("memory scheduling must follow successful finalization")

    monkeypatch.setattr(issue_workflow, "execute_activity", fake_execute_activity)
    monkeypatch.setattr(
        issue_workflow,
        "finalize_review_run",
        fail_finalization,
    )
    monkeypatch.setattr(
        issue_workflow,
        "schedule_memory_extractions",
        unexpected_schedule,
    )

    with pytest.raises(RuntimeError, match="storage unavailable"):
        await issue_workflow.IssueReviewWorkflow().run(
            ReviewWorkflowRequest(
                workflow="issue-review",
                run_id="run-1",
                prepared_input={"artifact_root_path": "/tmp/run-1/artifacts"},
                timeout_seconds=30,
                runtime_context={},
            )
        )
