from datetime import timedelta

import pytest

from sec_review_agents.contract_versions import EXECUTION_API_VERSION
from sec_review_agents.run_diagnostics.publication import (
    RunDiagnosticPublicationRequest,
)
from sec_review_agents.workflows.issue import single_agent as single_agent_workflow
from sec_review_agents.workflows.issue import two_stage as two_stage_workflow
from sec_review_agents.workflows.issue import workflow as issue_workflow
from sec_review_agents.workflows.pull_request import workflow as pr_workflow
from sec_review_agents.workflows.repository import workflow as repository_workflow
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
    ("workflow_module", "workflow_class"),
    [
        (two_stage_workflow, two_stage_workflow.IssueTwoStageWorkflow),
        (single_agent_workflow, single_agent_workflow.IssueSingleAgentWorkflow),
    ],
)
async def test_issue_ablation_publishes_without_scheduling_memory(
    monkeypatch,
    workflow_module,
    workflow_class,
) -> None:
    publications: list[RunDiagnosticPublicationRequest] = []
    public_result = {"api_version": EXECUTION_API_VERSION}

    async def fake_execute_activity(activity_fn, *args, **kwargs):
        activity_args = kwargs.get("args", args)
        if activity_fn.__name__.startswith("build_"):
            return public_result
        if activity_fn is workflow_module.publish_run_diagnostic_activity:
            publications.append(activity_args[0])
            return _finalized("review")
        return {}

    monkeypatch.setattr(
        workflow_module.workflow, "execute_activity", fake_execute_activity
    )

    result = await workflow_class().run(
        ReviewWorkflowRequest(
            workflow="issue-review",
            run_id="run-1",
            prepared_input={"artifact_root_path": "/tmp/run-1/artifacts"},
            timeout_seconds=30,
            runtime_context={},
            post_processing=ReviewPostProcessingPolicy(diagnostic_publication="local"),
        )
    )

    assert result == {
        "ok": True,
        "result": public_result,
        "artifact_storage": _finalized("review")["artifact_storage"],
    }
    assert publications == [
        RunDiagnosticPublicationRequest(
            run_id="run-1",
            artifact_root_path="/tmp/run-1/artifacts",
            review_units=[
                {
                    "review_unit_id": "review",
                    "transcript_root": "/tmp/run-1/artifacts/transcripts",
                }
            ],
            result=public_result,
            publication="local",
        )
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("workflow_module", "workflow_class", "workflow_name"),
    [
        (issue_workflow, issue_workflow.IssueReviewWorkflow, "issue-review"),
        (pr_workflow, pr_workflow.PullRequestReviewWorkflow, "pull-request-review"),
    ],
)
async def test_single_review_publishes_before_scheduling_memory(
    monkeypatch,
    workflow_module,
    workflow_class,
    workflow_name,
) -> None:
    events: list[str] = []
    publications: list[RunDiagnosticPublicationRequest] = []

    async def fake_execute_activity(activity_fn, *args, **kwargs):
        activity_args = kwargs.get("args", args)
        if activity_fn.__name__.startswith("build_"):
            return {"api_version": EXECUTION_API_VERSION}
        if activity_fn is workflow_module.publish_run_diagnostic_activity:
            assert kwargs["schedule_to_close_timeout"] == timedelta(seconds=30)
            events.append("publish")
            publications.append(activity_args[0])
            return _finalized("review")
        return {}

    async def fake_schedule(**kwargs):
        events.append("schedule")
        assert kwargs["review_unit_ids"] == ["review"]
        return {"extractions": []}

    monkeypatch.setattr(
        workflow_module.workflow, "execute_activity", fake_execute_activity
    )
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

    assert result["result"] == {"api_version": EXECUTION_API_VERSION}
    assert events == ["publish", "schedule"]
    assert publications[0].review_units == [
        {
            "review_unit_id": "review",
            "transcript_root": "/tmp/run-1/artifacts/transcripts",
        }
    ]


@pytest.mark.asyncio
async def test_repository_publishes_one_run_bundle_with_case_units(
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

    async def fake_execute_activity(activity_fn, *args, **kwargs):
        activity_args = kwargs.get("args", args)
        if activity_fn is repository_workflow.build_repository_review_result_activity:
            return {"api_version": EXECUTION_API_VERSION}
        if activity_fn is repository_workflow.publish_run_diagnostic_activity:
            publications.append(activity_args[0])
            return _finalized("case-a", "case-b")
        return {}

    async def fake_execute_child_workflow(*_args, **_kwargs):
        return next(child_results)

    async def fake_schedule(**kwargs):
        assert kwargs["review_unit_ids"] == ["case-a", "case-b"]
        return {"extractions": []}

    monkeypatch.setattr(
        repository_workflow.workflow, "execute_activity", fake_execute_activity
    )
    monkeypatch.setattr(
        repository_workflow.workflow,
        "execute_child_workflow",
        fake_execute_child_workflow,
    )
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
    async def fake_execute_activity(activity_fn, *args, **kwargs):
        activity_args = kwargs.get("args", args)
        if activity_fn is repository_workflow.build_repository_review_result_activity:
            return {"api_version": EXECUTION_API_VERSION}
        if activity_fn is repository_workflow.publish_run_diagnostic_activity:
            publications.append(activity_args[0])
            return _finalized()
        return {}

    async def fake_execute_child_workflow(*_args, **_kwargs):
        return {}

    publications: list[RunDiagnosticPublicationRequest] = []

    monkeypatch.setattr(
        repository_workflow.workflow, "execute_activity", fake_execute_activity
    )
    monkeypatch.setattr(
        repository_workflow.workflow,
        "execute_child_workflow",
        fake_execute_child_workflow,
    )

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
async def test_disabling_memory_does_not_skip_review_publication(monkeypatch) -> None:
    events: list[str] = []

    async def fake_execute_activity(activity_fn, *args, **_kwargs):
        if activity_fn is issue_workflow.build_issue_review_result_activity:
            return {"api_version": EXECUTION_API_VERSION}
        if activity_fn is issue_workflow.publish_run_diagnostic_activity:
            events.append("publish")
            return _finalized("review")
        return {}

    async def fake_schedule(**kwargs):
        events.append("schedule")
        assert kwargs["enabled"] is False
        return {"extractions": []}

    monkeypatch.setattr(
        issue_workflow.workflow, "execute_activity", fake_execute_activity
    )
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

    assert events == ["publish", "schedule"]


@pytest.mark.asyncio
async def test_publication_failure_fails_review_before_memory_scheduling(
    monkeypatch,
) -> None:
    async def fake_execute_activity(activity_fn, *args, **_kwargs):
        if activity_fn is issue_workflow.build_issue_review_result_activity:
            return {"api_version": EXECUTION_API_VERSION}
        if activity_fn is issue_workflow.publish_run_diagnostic_activity:
            raise RuntimeError("storage unavailable")
        return {}

    async def unexpected_schedule(**_kwargs):
        raise AssertionError("memory scheduling must follow successful publication")

    monkeypatch.setattr(
        issue_workflow.workflow, "execute_activity", fake_execute_activity
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
