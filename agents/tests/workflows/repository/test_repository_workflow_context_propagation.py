from pathlib import Path
from unittest.mock import patch

import pytest

import sec_review_agents.workflows.repository_case.workflow as repository_case_workflow
from sec_review_agents.workflows.repository_case.input import (
    RepositoryCaseExecutionInput,
)
from sec_review_agents.workflows.repository_case.workflow import (
    RepositoryCaseReviewRequest,
)
from sec_review_agents.workflows.review_intent import TEST_CHANGES_ALLOW


def repository_case_execution_input(case_id: str) -> RepositoryCaseExecutionInput:
    return {
        "case_id": case_id,
        "review_input": f"Prepared {case_id} input.",
        "workspace_snapshot_tar_path": "/tmp/workspace.snapshot.tar",
        "history_path": "/tmp/history",
        "scan_mode": "full",
        "incremental_window_path": None,
        "test_changes": TEST_CHANGES_ALLOW,
    }


@pytest.mark.asyncio
async def test_repository_case_activity_binds_trace_context() -> None:
    analyzer_result = {"verdict": "confirmed-vulnerability"}
    published_trajectories_path = "/tmp/cases/case-1/trajectories"

    with (
        patch(
            "sec_review_agents.observability.trace_context.bind_trace_context"
        ) as bind_mock,
        patch(
            "sec_review_agents.workflows.repository_case.stage.analyze_repository_case_stage",
            return_value=analyzer_result,
        ) as analyzer_stage_mock,
    ):
        request: RepositoryCaseReviewRequest = {
            "run_id": "run-1",
            "case_execution_input": repository_case_execution_input("case-1"),
            "cases_artifacts_path": "/tmp/cases",
            "published_trajectories_path": published_trajectories_path,
            "timeout_seconds": 30,
            "runtime_context": {},
        }
        result = await repository_case_workflow.analyze_repository_case_activity(
            request,
            {
                "case_execution_input": repository_case_execution_input("case-1"),
                "artifact_paths": {
                    "analyzer": "/tmp/cases/case-1/analyzer",
                    "cvss": "/tmp/cases/case-1/cvss",
                    "mitigator": "/tmp/cases/case-1/mitigator",
                    "verifier": "/tmp/cases/case-1/verifier",
                },
                "published_trajectories_path": published_trajectories_path,
            },
        )

    assert bind_mock.call_args.kwargs["workflow"] == "repository-review"
    assert bind_mock.call_args.kwargs["run_id"] == "run-1"
    assert bind_mock.call_args.kwargs["case_id"] == "case-1"
    assert analyzer_stage_mock.call_args.kwargs["published_trajectory_path"] == (
        Path(published_trajectories_path) / "0001-analyzer-initial.jsonl"
    )
    assert result == analyzer_result
