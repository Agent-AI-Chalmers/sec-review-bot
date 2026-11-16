import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from sec_review_agents.workflows.repository_case.input import (
    RepositoryCaseExecutionInput,
)
from sec_review_agents.workflows.repository_case.stage import (
    score_repository_case_cvss_stage,
)
from tests.analysis_fixtures import analysis_fixture


@pytest.mark.asyncio
async def test_cvss_stage_persists_failure_before_reraising(tmp_path: Path) -> None:
    """Persist failures the running scoring activity can actually observe."""
    cvss_artifacts_path = tmp_path / "cvss"

    with (
        patch(
            "sec_review_agents.workflows.repository_case.stage.score_repository_cvss_v4",
            new=AsyncMock(side_effect=RuntimeError("model unavailable")),
        ),
        pytest.raises(RuntimeError, match="model unavailable"),
    ):
        await score_repository_case_cvss_stage(
            RepositoryCaseExecutionInput.model_validate(
                {
                    "case_id": "case-1",
                    "history_path": str(tmp_path / "history"),
                    "scan_mode": "full",
                    "incremental_window_path": None,
                    "test_changes": "allow",
                    "review_input": "Review the reported vulnerability.",
                    "workspace_snapshot_tar_path": str(
                        tmp_path / "workspace.snapshot.tar"
                    ),
                }
            ),
            analysis_fixture(verdict="confirmed-vulnerability", narratives=[]),
            cvss_artifacts_path=cvss_artifacts_path,
        )

    assert json.loads(
        (cvss_artifacts_path / "cvss-v4-failure.json").read_text(encoding="utf-8")
    ) == {"error": "RuntimeError: model unavailable"}
    assert not (cvss_artifacts_path / "cvss-v4-result.json").exists()


@pytest.mark.asyncio
async def test_cvss_stage_does_not_report_cancellation_as_scoring_failure(
    tmp_path: Path,
) -> None:
    """Cancellation belongs to task orchestration, not CVSS scoring diagnostics."""
    cvss_artifacts_path = tmp_path / "cvss"

    with (
        patch(
            "sec_review_agents.workflows.repository_case.stage.score_repository_cvss_v4",
            new=AsyncMock(side_effect=asyncio.CancelledError),
        ),
        pytest.raises(asyncio.CancelledError),
    ):
        await score_repository_case_cvss_stage(
            RepositoryCaseExecutionInput.model_validate(
                {
                    "case_id": "case-1",
                    "history_path": str(tmp_path / "history"),
                    "scan_mode": "full",
                    "incremental_window_path": None,
                    "test_changes": "allow",
                    "review_input": "Review the reported vulnerability.",
                    "workspace_snapshot_tar_path": str(
                        tmp_path / "workspace.snapshot.tar"
                    ),
                }
            ),
            analysis_fixture(verdict="confirmed-vulnerability", narratives=[]),
            cvss_artifacts_path=cvss_artifacts_path,
        )

    assert not cvss_artifacts_path.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("failed_stage", ["mitigation", "verification"])
@pytest.mark.parametrize("cancelled", [False, True])
async def test_direct_case_failure_cancels_and_awaits_cvss(
    tmp_path: Path, failed_stage: str, cancelled: bool
) -> None:
    """Scoring must not outlive a failed or cancelled review and write artifacts afterward."""
    from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
    from sec_review_agents.workflows.repository_case import direct
    from sec_review_agents.workflows.repository_case.workflow import (
        RepositoryCaseReviewRequest,
    )

    scoring_started = asyncio.Event()
    scoring_cleaned_up = asyncio.Event()
    failure = asyncio.CancelledError() if cancelled else RuntimeError("review failed")
    request = RepositoryCaseReviewRequest(
        run_id="cvss-cleanup",
        case_execution_input=RepositoryCaseExecutionInput(
            case_id="case-1",
            history_path=str(tmp_path / "history"),
            scan_mode="full",
            incremental_window_path=None,
            test_changes="allow",
            review_input="Review case.",
            workspace_snapshot_tar_path=str(tmp_path / "snapshot.tar"),
        ),
        cases_artifacts_path=str(tmp_path / "cases"),
        published_trajectories_path=str(tmp_path / "trajectories"),
        timeout_seconds=30,
        runtime_context={},
    )

    async def score(*_args: object) -> None:
        scoring_started.set()
        try:
            await asyncio.Future()
        finally:
            # Yield during cleanup to distinguish awaiting cancellation from merely requesting it.
            await asyncio.sleep(0)
            scoring_cleaned_up.set()

    async def mitigate(*_args: object) -> MitigationStageResult:
        await scoring_started.wait()
        if failed_stage == "mitigation":
            raise failure
        return MitigationStageResult(overview="mitigated", file_changes=[])

    with (
        patch.object(
            direct,
            "analyze_repository_case_activity",
            new=AsyncMock(
                return_value=analysis_fixture(
                    verdict="no-actionable-finding", narratives=[]
                )
            ),
        ),
        patch.object(direct, "score_repository_case_cvss_activity", new=score),
        patch.object(direct, "mitigate_repository_case_activity", new=mitigate),
        patch.object(
            direct,
            "verify_repository_case_activity",
            new=AsyncMock(side_effect=failure),
        ),
        patch.object(direct, "build_repository_case_result_activity") as builder,
    ):
        with pytest.raises(type(failure)) as caught:
            await asyncio.wait_for(
                direct.run_repository_case_review_direct(request), timeout=5
            )
        assert caught.value is failure
        assert scoring_cleaned_up.is_set()
        builder.assert_not_called()
