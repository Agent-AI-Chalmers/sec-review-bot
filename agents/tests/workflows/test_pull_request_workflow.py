from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from sec_review_agents.review_stages.verification.result import VerificationStageResult
from sec_review_agents.workflows.prepared_input import PreparedPullRequestInput
from sec_review_agents.workflows.pull_request.direct import (
    run_pull_request_review_direct,
)
from sec_review_agents.workflows.pull_request.workflow import (
    mitigate_pull_request_activity,
    verify_pull_request_activity,
)
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest
from tests.analysis_fixtures import analysis_fixture, narrative_fixture
from tests.prepared_input_fixtures import prepared_pull_request_input


def _prepared_input(artifact_root: Path) -> PreparedPullRequestInput:
    return prepared_pull_request_input(
        artifact_root_path=str(artifact_root),
        mitigator_artifacts_path=str(artifact_root / "mitigator"),
        workspace_snapshot_tar_path=str(artifact_root / "workspace.tar"),
        history_path=str(artifact_root / "history"),
        incremental_window_path=str(artifact_root / "incremental.json"),
    )


def _request(artifact_root: Path) -> ReviewWorkflowRequest:
    return ReviewWorkflowRequest(
        workflow="pull-request-review",
        run_id="run-test",
        prepared_input=_prepared_input(artifact_root),
        timeout_seconds=30,
        runtime_context={},
    )


@pytest.mark.asyncio
async def test_mitigation_activity_skip_accepts_serialized_artifact_root(
    tmp_path: Path,
) -> None:
    """Activity inputs cross a serialization boundary with string paths."""
    artifact_root = tmp_path / "artifacts"

    result = await mitigate_pull_request_activity(
        request=_request(artifact_root),
        analysis_result=analysis_fixture(verdict=None, narratives=[]),
        retry_context=None,
    )

    assert result.file_changes == []
    assert (artifact_root / "mitigator" / "mitigation-result.json").is_file()


@pytest.mark.asyncio
async def test_mitigation_activity_run_accepts_serialized_artifact_root(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    artifact_root = tmp_path / "artifacts"
    captured: dict[str, Any] = {}

    async def fake_mitigate_pull_request(**kwargs: Any) -> MitigationStageResult:
        captured.update(kwargs)
        return MitigationStageResult(
            overview="Test mitigation",
            file_changes=[],
        )

    monkeypatch.setattr(
        "sec_review_agents.workflows.pull_request.mitigation.mitigate_pull_request",
        fake_mitigate_pull_request,
    )

    result = await mitigate_pull_request_activity(
        request=_request(artifact_root),
        analysis_result=analysis_fixture(
            verdict=None, narratives=[narrative_fixture(verdict="confirmed-defect")]
        ),
        retry_context=None,
    )

    assert result.file_changes == []
    assert result.overview == "Test mitigation"
    assert captured["workspace_snapshot_tar_path"] == artifact_root / "workspace.tar"
    assert captured["history_path"] == artifact_root / "history"
    assert captured["incremental_window_path"] == artifact_root / "incremental.json"
    assert captured["mitigator_artifacts_path"] == artifact_root / "mitigator"
    assert captured["published_trajectory_path"] == (
        artifact_root / "trajectories" / "0002-mitigator-initial.jsonl"
    )


@pytest.mark.asyncio
async def test_direct_review_records_skipped_verification_without_confirmed_target() -> (
    None
):
    analysis_result = analysis_fixture(verdict="no-actionable-finding", narratives=[])
    mitigation_result = MitigationStageResult(
        overview="No confirmed repair target.", file_changes=[], patch_diff=""
    )
    verifier_result = VerificationStageResult(
        overview="Verification skipped.",
        resolution_next_step="none",
        review_target_claim=None,
        patch_coverage=None,
        validation_level=None,
        regression_status=None,
    )
    request = ReviewWorkflowRequest(
        workflow="pull-request-review",
        run_id="run-no-target",
        prepared_input=prepared_pull_request_input(),
        timeout_seconds=30,
        runtime_context={},
    )

    with (
        patch(
            "sec_review_agents.workflows.pull_request.direct.analyze_pull_request_activity",
            return_value=analysis_result,
        ),
        patch(
            "sec_review_agents.workflows.pull_request.direct.mitigate_pull_request_activity",
            return_value=mitigation_result,
        ),
        patch(
            "sec_review_agents.workflows.pull_request.direct.verify_pull_request_activity",
            return_value=verifier_result,
        ) as verify_mock,
        patch(
            "sec_review_agents.workflows.pull_request.direct.build_pull_request_review_result_activity",
            return_value={"review_record": {}},
        ) as build_result_mock,
    ):
        await run_pull_request_review_direct(request)

    verify_mock.assert_awaited_once_with(
        request,
        analysis_result,
        mitigation_result,
        None,
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
    prepared_input = prepared_pull_request_input(
        artifact_root_path=str(artifact_root),
        verifier_artifacts_path=str(artifact_root / "verifier"),
    )

    with patch(
        "sec_review_agents.workflows.pull_request.verification.verify_pull_request"
    ) as verify_mock:
        result = await verify_pull_request_activity(
            ReviewWorkflowRequest(
                workflow="pull-request-review",
                run_id="run-test",
                prepared_input=prepared_input,
                timeout_seconds=30,
                runtime_context={},
            ),
            analysis_fixture(verdict="no-actionable-finding", narratives=[]),
            MitigationStageResult(overview="Test mitigation"),
            None,
        )

    verify_mock.assert_not_called()
    assert result.patch_coverage is None
    assert (artifact_root / "verifier" / "verification-result.json").is_file()
