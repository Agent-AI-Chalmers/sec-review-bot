import json
from pathlib import Path

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
from sec_review_agents.workflows.issue.single_agent import IssueSingleAgentWorkflow
from sec_review_agents.workflows.issue.two_stage import IssueTwoStageWorkflow
from sec_review_agents.workflows.issue.workflow import IssueReviewWorkflow


def _issue_bundle(strategy: IssueReviewStrategy | None) -> ReviewBundle:
    return ReviewBundle(
        workflow="issue-review",
        run_id="run-1",
        input={},
        local_root_path=Path("/tmp/run-1"),
        artifact_root_path=Path("/tmp/run-1/artifacts"),
        issue_strategy=strategy,
    )


def _prepared_issue_bundle(tmp_path: Path) -> ReviewBundle:
    local_root = tmp_path / "run-1"
    local_root.mkdir()
    (local_root / "manifest.json").write_text(
        json.dumps(
            {
                "contract_version": "v4",
                "kind": "runner-input-bundle",
                "workspace": {"snapshot": "workspace.snapshot.tar"},
                "history": {"path": "history"},
            }
        ),
        encoding="utf-8",
    )
    return ReviewBundle(
        workflow="issue-review",
        run_id="run-1",
        input={
            "contract_version": "v4",
            "review_intent": {
                "objective": "repair",
                "repair_mode": "test-changes-allowed",
            },
            "issue": {"title": "Issue", "body": "Body"},
            "input_bundle_uri": str(local_root),
        },
        local_root_path=local_root,
        artifact_root_path=local_root / "artifacts",
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


def test_local_temporal_uses_materialized_artifact_root(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("SEC_REVIEW_AGENT_ARTIFACT_ROOT", "/tmp/from-env")
    bundle = _prepared_issue_bundle(tmp_path)
    config = LocalTemporalConfig(
        address="127.0.0.1:7233",
        namespace="default",
        task_queue="sec-review-agents",
        workflow_timeout_seconds=30,
    )

    request = build_local_workflow_request(
        bundle,
        timeout_seconds=config.workflow_timeout_seconds,
    )

    assert request.prepared_input["artifact_root_path"] == str(
        bundle.artifact_root_path
    )
    assert request.memory_extraction_registration_enabled is False
