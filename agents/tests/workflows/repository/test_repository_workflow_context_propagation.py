from pathlib import Path
from unittest.mock import patch

import pytest

import sec_review_agents.workflows.repository.workflow as repository_workflow
from sec_review_agents.workflows.repository.case_execution_input import (
    RepositoryCaseExecutionInput,
)
from sec_review_agents.workflows.review_intent import REPAIR_MODE_TEST_CHANGES_ALLOWED


def repository_case_execution_input(case_id: str) -> RepositoryCaseExecutionInput:
    return {
        "case_id": case_id,
        "review_input": f"Prepared {case_id} input.",
        "workspace_snapshot_tar_path": "/tmp/workspace.snapshot.tar",
        "history_path": "/tmp/history",
        "scan_mode": "full",
        "incremental_window_path": None,
        "repair_mode": REPAIR_MODE_TEST_CHANGES_ALLOWED,
    }


@pytest.mark.asyncio
async def test_repository_case_activity_binds_trace_context() -> None:
    analyzer_result = {"verdict": "confirmed-vulnerability"}
    transcript_thread_path = "/tmp/transcripts/0001-case-case-1"

    with (
        patch(
            "sec_review_agents.observability.trace_context.bind_trace_context"
        ) as bind_mock,
        patch(
            "sec_review_agents.workflows.repository_case.stage.analyze_repository_case_stage",
            return_value=analyzer_result,
        ) as analyzer_stage_mock,
    ):
        result = await repository_workflow.analyze_repository_case_activity(
            {
                "case_execution_input": repository_case_execution_input("case-1"),
                "artifact_paths": {
                    "analyzer": "/tmp/cases/case-1/analyzer",
                },
                "transcript_thread_path": transcript_thread_path,
            },
            {},
        )

    bind_mock.assert_called_once_with(workflow="repository-review")
    assert analyzer_stage_mock.call_args.kwargs["published_transcript_path"] == (
        Path(transcript_thread_path) / "0001-analyzer-initial.jsonl"
    )
    assert result == analyzer_result
