from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from sec_review_agents.workflows.issue.direct import run_issue_review_direct
from sec_review_agents.workflows.issue.workflow import (
    mitigate_issue_activity,
    verify_issue_activity,
)
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest


@pytest.mark.asyncio
async def test_mitigation_activity_accepts_serialized_artifact_root(
    tmp_path: Path,
) -> None:
    """Activity inputs cross a serialization boundary with string paths."""
    artifact_root = tmp_path / "artifacts"
    prepared_input: dict[str, Any] = {
        "artifact_root_path": str(artifact_root),
        "artifact_paths": {"mitigator": str(artifact_root / "mitigator")},
        "review_intent": {"objective": "audit"},
    }

    result = await mitigate_issue_activity(
        prepared_input=prepared_input,
        analysis_result={"narratives": []},
        retry_context=None,
        runtime_context={},
    )

    assert result["file_changes"] == []
    assert (artifact_root / "mitigator" / "mitigation-result.json").is_file()


@pytest.mark.asyncio
async def test_direct_review_records_skipped_verification_without_confirmed_target() -> (
    None
):
    analysis_result = {"verdict": "no-actionable-finding", "narratives": []}
    mitigation_result = {
        "overview": "No confirmed repair target.",
        "changed_files": [],
        "file_changes": [],
        "patch_diff": "",
    }
    verifier_result = {
        "overview": "Verification skipped.",
        "resolution_next_step": "none",
    }
    request = ReviewWorkflowRequest(
        workflow="issue-review",
        run_id="run-no-target",
        prepared_input={},
        timeout_seconds=30,
        runtime_context={},
    )

    with (
        patch(
            "sec_review_agents.workflows.issue.direct.prepare_internal_workflow_activity"
        ),
        patch(
            "sec_review_agents.workflows.issue.direct.analyze_issue_activity",
            return_value=analysis_result,
        ),
        patch(
            "sec_review_agents.workflows.issue.direct.mitigate_issue_activity",
            return_value=mitigation_result,
        ),
        patch(
            "sec_review_agents.workflows.issue.direct.verify_issue_activity",
            return_value=verifier_result,
        ) as verify_mock,
        patch(
            "sec_review_agents.workflows.issue.direct.build_issue_review_result_activity",
            return_value={"review_record": {}},
        ) as build_result_mock,
    ):
        await run_issue_review_direct(request)

    verify_mock.assert_awaited_once_with(
        {},
        analysis_result,
        mitigation_result,
        None,
        {},
    )
    build_result_mock.assert_called_once_with(
        analysis_result,
        mitigation_result,
        verifier_result,
    )


@pytest.mark.asyncio
async def test_verification_activity_persists_skip_without_running_verifier(
    tmp_path: Path,
) -> None:
    artifact_root = tmp_path / "artifacts"
    prepared_input = {
        "artifact_root_path": str(artifact_root),
        "artifact_paths": {"verifier": str(artifact_root / "verifier")},
    }

    with patch(
        "sec_review_agents.workflows.issue.verification.verify_issue"
    ) as verify_mock:
        result = await verify_issue_activity(
            prepared_input,
            {"verdict": "no-actionable-finding", "narratives": []},
            {"changed_files": []},
            None,
            {},
        )

    verify_mock.assert_not_called()
    assert result["patch_coverage"] is None
    assert (artifact_root / "verifier" / "verification-result.json").is_file()
