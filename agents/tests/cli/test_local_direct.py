import json
from pathlib import Path

import pytest

from sec_review_agents.cli.local_direct import run_local_direct_workflow
from sec_review_agents.cli.local_execution import (
    build_local_workflow_request,
    direct_run_for_bundle,
)
from sec_review_agents.cli.local_materialization.common import (
    IssueReviewStrategy,
    ReviewBundle,
    ReviewWorkflow,
)
from sec_review_agents.workflows.issue.direct import run_issue_review_direct
from sec_review_agents.workflows.issue.single_agent import (
    run_issue_single_agent_direct,
)
from sec_review_agents.workflows.issue.two_stage import (
    run_issue_two_stage_direct,
)
from sec_review_agents.workflows.pull_request.direct import (
    run_pull_request_review_direct,
)
from sec_review_agents.workflows.repository.direct import (
    run_repository_review_direct,
)


def _bundle(
    workflow: ReviewWorkflow,
    strategy: IssueReviewStrategy | None = None,
) -> ReviewBundle:
    return ReviewBundle(
        workflow=workflow,
        run_id="run-1",
        input={},
        local_root_path=Path("/tmp/run-1"),
        artifact_root_path=Path("/tmp/run-1/artifacts"),
        issue_strategy=strategy,
    )


def _prepared_issue_bundle(
    tmp_path: Path,
    *,
    strategy: IssueReviewStrategy | None = None,
    review_intent: dict[str, str] | None = None,
) -> ReviewBundle:
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
            "review_intent": review_intent
            or {
                "objective": "repair",
                "repair_mode": "test-changes-allowed",
            },
            "issue": {"title": "Issue", "body": "Body"},
            "input_bundle_uri": str(local_root),
        },
        local_root_path=local_root,
        artifact_root_path=local_root / "artifacts",
        issue_strategy=strategy,
    )


def _prepared_issue_ablation_request(
    tmp_path: Path,
    *,
    strategy: IssueReviewStrategy,
    review_intent: dict[str, str],
):
    bundle = _prepared_issue_bundle(
        tmp_path,
        strategy=strategy,
        review_intent=review_intent,
    )
    return build_local_workflow_request(bundle, timeout_seconds=60)


def test_local_default_routes_to_direct_runners() -> None:
    assert direct_run_for_bundle(_bundle("issue-review")) is run_issue_review_direct
    assert (
        direct_run_for_bundle(_bundle("pull-request-review"))
        is run_pull_request_review_direct
    )
    assert (
        direct_run_for_bundle(_bundle("repository-review"))
        is run_repository_review_direct
    )


def test_local_issue_ablation_routes_to_direct_callables() -> None:
    assert (
        direct_run_for_bundle(_bundle("issue-review", "two-stage"))
        is run_issue_two_stage_direct
    )
    assert (
        direct_run_for_bundle(_bundle("issue-review", "single-agent"))
        is run_issue_single_agent_direct
    )


def test_local_direct_uses_materialized_artifact_root(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("SEC_REVIEW_AGENT_ARTIFACT_ROOT", "/tmp/from-env")
    bundle = _prepared_issue_bundle(tmp_path)

    request = build_local_workflow_request(bundle, timeout_seconds=60)

    assert request.prepared_input["artifact_root_path"] == str(
        bundle.artifact_root_path
    )
    assert request.memory_extraction_registration_enabled is False


def test_local_direct_runs_review_only(
    tmp_path: Path,
    monkeypatch,
) -> None:
    bundle = _prepared_issue_bundle(tmp_path)
    calls: list[str] = []

    async def fake_direct(request):
        calls.append(f"direct:{request.run_id}")
        return {"ok": True}

    monkeypatch.setattr(
        "sec_review_agents.cli.local_direct.direct_run_for_bundle",
        lambda _bundle: fake_direct,
    )

    result = run_local_direct_workflow(bundle)

    assert result == {"ok": True}
    assert calls == ["direct:run-1"]


@pytest.mark.parametrize(
    ("strategy", "review_intent", "expected_message"),
    [
        (
            "two-stage",
            {"objective": "unknown"},
            "review_intent.objective must be 'audit' or 'repair'.",
        ),
        (
            "two-stage",
            {"objective": "repair", "repair_mode": "unknown"},
            "review_intent.repair_mode must be 'test-changes-allowed' or 'no-test-changes'.",
        ),
        (
            "single-agent",
            {"objective": "unknown"},
            "review_intent.objective must be 'audit' or 'repair'.",
        ),
        (
            "single-agent",
            {"objective": "repair", "repair_mode": "unknown"},
            "review_intent.repair_mode must be 'test-changes-allowed' or 'no-test-changes'.",
        ),
    ],
)
def test_local_issue_ablation_direct_rejects_invalid_review_intent(
    tmp_path: Path,
    strategy: IssueReviewStrategy,
    review_intent: dict[str, str],
    expected_message: str,
) -> None:
    with pytest.raises(ValueError, match=expected_message):
        _prepared_issue_ablation_request(
            tmp_path,
            strategy=strategy,
            review_intent=review_intent,
        )
