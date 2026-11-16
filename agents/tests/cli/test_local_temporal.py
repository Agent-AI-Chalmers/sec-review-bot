import asyncio
import uuid
from dataclasses import replace
from pathlib import Path

import pytest
from temporalio import workflow
from temporalio.worker import Worker

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.cli import local_temporal
from sec_review_agents.cli.local_execution import (
    build_local_workflow_request,
    local_workflow_id,
    temporal_run_for_bundle,
)
from sec_review_agents.cli.local_materialization.common import (
    IssueReviewStrategy,
    ReviewBundle,
)
from sec_review_agents.cli.local_temporal import (
    LocalTemporalConfig,
)
from sec_review_agents.contract_versions import EXECUTION_API_VERSION
from sec_review_agents.execution_archives.models import ExecutionArchive
from sec_review_agents.workflows.issue.single_agent import IssueSingleAgentWorkflow
from sec_review_agents.workflows.issue.two_stage import IssueTwoStageWorkflow
from sec_review_agents.workflows.issue.workflow import IssueReviewWorkflow
from sec_review_agents.workflows.result import ReviewWorkflowSuccess
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest
from tests.input_bundle import write_test_input_bundle
from tests.temporal_test_utils import temporal_time_skipping_environment


def _issue_bundle(strategy: IssueReviewStrategy | None) -> ReviewBundle:
    return ReviewBundle(
        workflow="issue-review",
        run_id="run-1",
        input={},
        local_root_path=Path("/tmp/run-1"),
        issue_strategy=strategy,
    )


def _prepared_issue_bundle(tmp_path: Path) -> ReviewBundle:
    local_root = tmp_path / "run-1"
    local_root.mkdir()
    return ReviewBundle(
        workflow="issue-review",
        run_id="run-1",
        input={
            "api_version": EXECUTION_API_VERSION,
            "review_intent": {
                "objective": "repair",
                "test_changes": "allow",
            },
            "issue": {
                "owner": "octo",
                "repo": "demo",
                "repo_full_name": "octo/demo",
                "number": 7,
                "title": "Issue",
                "body": "Body",
            },
            "input_bundle": write_test_input_bundle(local_root),
        },
        local_root_path=local_root,
    )


def test_local_issue_strategy_routes_to_temporal_workflow() -> None:
    assert temporal_run_for_bundle(_issue_bundle("default")) is IssueReviewWorkflow.run
    assert (
        temporal_run_for_bundle(_issue_bundle("two-stage")) is IssueTwoStageWorkflow.run
    )
    assert (
        temporal_run_for_bundle(_issue_bundle("single-agent"))
        is IssueSingleAgentWorkflow.run
    )


def test_local_issue_strategy_uses_distinct_workflow_id() -> None:
    assert local_workflow_id(_issue_bundle("default")) == "run-1"
    assert local_workflow_id(_issue_bundle("two-stage")) == "run-1:two-stage"
    assert local_workflow_id(_issue_bundle("single-agent")) == "run-1:single-agent"


def test_local_temporal_request_respects_memory_processing_flag(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("AGENT_MEMORY_PROCESSING_ENABLED", "false")
    request = build_local_workflow_request(
        _prepared_issue_bundle(tmp_path), timeout_seconds=30
    )

    assert request.post_processing.memory_processing_enabled is False
    assert request.post_processing.execution_archive_scheme == "file"


def test_local_temporal_uses_materialized_artifact_root(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("SEC_REVIEW_AGENT_ARTIFACT_ROOT", "/tmp/from-env")
    bundle = _prepared_issue_bundle(tmp_path)
    config = LocalTemporalConfig(
        address="127.0.0.1:7233",
        namespace="default",
        task_queue="sec-review-execution",
        workflow_timeout_seconds=30,
    )

    request = build_local_workflow_request(
        bundle,
        timeout_seconds=config.workflow_timeout_seconds,
    )

    assert request.prepared_input.artifact_root_path == str(bundle.artifact_root_path)


@workflow.defn(name="IssueReviewWorkflow", sandboxed=False)
class LocalRuntimeProbe:
    @workflow.run
    async def run(self, request: ReviewWorkflowRequest) -> ReviewWorkflowSuccess:
        archive = ExecutionArchive(
            reference=ArtifactReference(
                uri="file:///tmp/local-runtime/execution-archive.v1.tar.zst",
                digest=f"sha256:{'a' * 64}",
                media_type="application/tar+zstd",
                size_bytes=42,
            ),
            unit_ids=(),
        )
        return {
            "ok": True,
            "result": {"runtime_context": dict(request.runtime_context)},
            "memory_processing": None,
            "artifact_storage": archive.to_artifact_storage(),
        }


@pytest.mark.asyncio
async def test_local_temporal_delivers_image_and_workspace_overrides(
    tmp_path: Path, monkeypatch
) -> None:
    """Removing the public override channel must preserve local Temporal evaluation."""
    bundle = replace(
        _prepared_issue_bundle(tmp_path),
        runtime_config={
            "workspace_image": "evaluation:latest",
            "workspace_path": "/app/evaluation",
        },
    )
    monkeypatch.setenv("EXECUTION_ALLOW_WORKSPACE_IMAGE_OVERRIDE", "true")
    queue = f"local-runtime-{uuid.uuid4()}"
    monkeypatch.setenv("TEMPORAL_EXECUTION_TASK_QUEUE", queue)
    async with temporal_time_skipping_environment() as env:

        async def connect(**kwargs):
            return env.client

        monkeypatch.setattr(local_temporal, "connect_temporal_client", connect)
        async with Worker(env.client, task_queue=queue, workflows=[LocalRuntimeProbe]):
            result = await asyncio.wait_for(
                local_temporal._run_local_temporal_workflow(bundle), timeout=15
            )
    assert result == {
        "runtime_context": {
            "workspace_image": "evaluation:latest",
            "workspace_path": "/app/evaluation",
        }
    }
