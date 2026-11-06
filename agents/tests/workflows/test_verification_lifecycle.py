from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from sec_review_agents.resources.loader import load_prompt_resource
from sec_review_agents.review_stages.feedback_loop import feedback_retry_context
from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from sec_review_agents.workflows.issue.verification import verify_issue
from sec_review_agents.workflows.pull_request.verification import verify_pull_request
from sec_review_agents.workflows.repository_case.verification import (
    verify_repository_case,
)
from tests.analysis_fixtures import analysis_fixture


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
            analysis_result=analysis_fixture(
                overview="analysis", verdict=None, narratives=[]
            ),
            mitigation_result=MitigationStageResult(overview="Test mitigation"),
            retry_context=None,
        )

    assert not (verifier_artifacts / "verification-result.json").exists()
    assert not (verifier_artifacts / "verification-result.initial.json").exists()


@pytest.mark.asyncio
async def test_pr_verification_resets_artifacts_before_workspace_prepare_failure(
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

    # The verifier no longer reads a diff artifact, so a missing one cannot be the failure this
    # guards. The workspace snapshot is what the stage needs first, and the reset must still have
    # happened by the time it fails.
    with pytest.raises(
        FileNotFoundError,
        match="Workspace snapshot tar not found",
    ):
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
            analysis_result=analysis_fixture(
                overview="analysis", verdict=None, narratives=[]
            ),
            mitigation_result=MitigationStageResult(overview="Test mitigation"),
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
            "sec_review_agents.workflows.repository_case.verification.build_repository_verification_user_prompt",
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
            analysis_result=analysis_fixture(
                overview="analysis", verdict=None, narratives=[]
            ),
            mitigation_result=MitigationStageResult(overview="Test mitigation"),
        )

    run_verification_stage_mock.assert_not_called()


@pytest.mark.asyncio
async def test_repository_verification_preserves_patch_terminal_newline(
    tmp_path: Path,
) -> None:
    """Keep an exported unified diff byte-for-byte valid on its way to verification."""
    patch_diff = "diff --git a/a.txt b/a.txt\n"

    with (
        patch(
            "sec_review_agents.workflows.repository_case.verification.reset_verification_attempt_artifacts"
        ),
        patch(
            "sec_review_agents.workflows.repository_case.verification.build_repository_verification_user_prompt",
            return_value="user prompt",
        ) as build_prompt,
        patch(
            "sec_review_agents.workflows.repository_case.verification.run_verification_stage",
            return_value={"coverage": "full"},
        ) as run_verification_stage_mock,
    ):
        await verify_repository_case(
            workspace_snapshot_tar_path=tmp_path / "workspace.snapshot.tar",
            history_path=None,
            incremental_window_path=None,
            verifier_artifacts_path=tmp_path / "verifier",
            scan_mode="full",
            review_input="review input",
            analysis_result=analysis_fixture(
                overview="analysis", verdict=None, narratives=[]
            ),
            mitigation_result=MitigationStageResult(
                overview="Test mitigation", patch_diff=patch_diff
            ),
        )

    assert build_prompt.call_args.kwargs["workspace_patch"] == patch_diff
    assert run_verification_stage_mock.call_args.kwargs["workspace_patch"] == patch_diff


@pytest.mark.asyncio
@pytest.mark.parametrize("scope", ["issue", "pull_request", "repository_case"])
@pytest.mark.parametrize("test_changes", ["allow", "deny"])
@pytest.mark.parametrize("is_retry", [False, True])
async def test_verification_passes_test_policy_to_stage(
    tmp_path: Path, scope: str, test_changes, is_retry: bool
) -> None:
    """Exercise real prompt composition so wrapper defaults cannot hide a deny policy."""
    analysis = analysis_fixture(verdict=None, narratives=[])
    retry = (
        feedback_retry_context(
            retry_index=1, mitigation_result=None, verifier_result=None
        )
        if is_retry
        else None
    )
    kwargs: dict[str, Any] = {
        "workspace_snapshot_tar_path": tmp_path / "snapshot.tar",
        "history_path": tmp_path / "history",
        "verifier_artifacts_path": tmp_path / "verifier",
        "analysis_result": analysis,
        "mitigation_result": None,
        "retry_context": retry,
        "test_changes": test_changes,
    }
    with patch(
        f"sec_review_agents.workflows.{scope}.verification.run_verification_stage"
    ) as stage:
        if scope == "issue":
            await verify_issue(issue={}, **kwargs)
        elif scope == "pull_request":
            await verify_pull_request(
                pr={}, incremental_window_path=tmp_path / "window", **kwargs
            )
        else:
            await verify_repository_case(
                review_input="Review the scoped claim.",
                scan_mode="full",
                incremental_window_path=None,
                **kwargs,
            )
    prompt = stage.call_args.kwargs["system_prompt"]
    assert (
        load_prompt_resource(f"test-changes-policy/{test_changes}-boundary.md")
        in prompt
    )
