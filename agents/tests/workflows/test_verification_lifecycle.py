from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.workflows.issue.verification import verify_issue
from sec_review_agents.workflows.pull_request.verification import verify_pull_request
from sec_review_agents.workflows.repository_case.verification import (
    verify_repository_case,
)


@pytest.mark.asyncio
async def test_issue_verification_resets_artifacts_before_workspace_prepare_failure(
    tmp_path: Path,
) -> None:
    verifier_artifacts = tmp_path / "verifier"
    verifier_artifacts.mkdir()
    (verifier_artifacts / "verification-result.json").write_text(
        '{"overview": "stale"}',
        encoding="utf-8",
    )
    (verifier_artifacts / "verification-result.initial.json").write_text(
        '{"overview": "stale initial"}',
        encoding="utf-8",
    )

    with pytest.raises(
        FileNotFoundError,
        match="Workspace snapshot tar not found",
    ):
        await verify_issue(
            issue={"title": "issue", "body": "body"},
            workspace_snapshot_tar_path=tmp_path / "workspace.snapshot.tar",
            history_path=tmp_path / "history.json",
            verifier_artifacts_path=verifier_artifacts,
            analysis_result={"overview": "analysis"},
            mitigation_result={"changed_files": ["demo.txt"]},
            retry_context=None,
        )

    assert not (verifier_artifacts / "verification-result.json").exists()
    assert not (verifier_artifacts / "verification-result.initial.json").exists()


@pytest.mark.asyncio
async def test_pr_verification_resets_artifacts_before_diff_metadata_failure(
    tmp_path: Path,
) -> None:
    verifier_artifacts = tmp_path / "verifier"
    verifier_artifacts.mkdir()
    (verifier_artifacts / "verification-result.json").write_text(
        '{"overview": "stale"}',
        encoding="utf-8",
    )
    (verifier_artifacts / "verification-result.initial.json").write_text(
        '{"overview": "stale initial"}',
        encoding="utf-8",
    )

    with pytest.raises(FileNotFoundError):
        await verify_pull_request(
            pr={
                "title": "PR",
                "body": "Body",
                "base_ref": "main",
                "base_sha": "base",
                "head_ref": "branch",
                "head_sha": "head",
                "commit_shas": ["head"],
            },
            workspace_snapshot_tar_path=tmp_path / "workspace.snapshot.tar",
            history_path=tmp_path / "history.json",
            incremental_window_path=tmp_path / "incremental-window",
            verifier_artifacts_path=verifier_artifacts,
            analysis_result={"overview": "analysis"},
            mitigation_result={"changed_files": []},
            retry_context=None,
        )

    assert not (verifier_artifacts / "verification-result.json").exists()
    assert not (verifier_artifacts / "verification-result.initial.json").exists()


@pytest.mark.asyncio
async def test_repository_verification_does_not_prepare_workspace_when_prompt_build_fails(
    tmp_path: Path,
) -> None:
    with (
        patch(
            "sec_review_agents.workflows.repository_case.verification.run_verification_stage"
        ) as run_verification_stage_mock,
        patch(
            "sec_review_agents.agents.verification.repository.build_repository_verification_user_prompt",
            side_effect=RuntimeError("prompt failed"),
        ),
        pytest.raises(RuntimeError, match="prompt failed"),
    ):
        await verify_repository_case(
            workspace_snapshot_tar_path=tmp_path / "workspace.snapshot.tar",
            history_path=None,
            incremental_window_path=None,
            verifier_artifacts_path=tmp_path / "verifier",
            scan_mode="full",
            review_input="review input",
            analysis_result={"overview": "analysis"},
            mitigation_result={"changed_files": []},
        )

    run_verification_stage_mock.assert_not_called()
