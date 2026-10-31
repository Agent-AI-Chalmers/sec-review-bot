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
