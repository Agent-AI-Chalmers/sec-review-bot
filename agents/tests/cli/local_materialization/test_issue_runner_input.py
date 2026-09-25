import os
import subprocess
from pathlib import Path
from unittest.mock import patch

from sec_review_agents.cli.local_materialization.common import (
    ReviewBundle,
    default_local_output_dir,
    result_path_for_bundle,
)
from sec_review_agents.cli.local_materialization.issue import (
    build_local_issue_bundle,
)


def _run_git(repo_path: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo_path,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _create_repo(repo_path: Path) -> None:
    repo_path.mkdir()
    _run_git(repo_path, "init", "-b", "main")
    _run_git(repo_path, "config", "user.name", "Test User")
    _run_git(repo_path, "config", "user.email", "test@example.com")
    (repo_path / "README.md").write_text("# test\n", encoding="utf-8")
    _run_git(repo_path, "add", "README.md")
    _run_git(repo_path, "commit", "-m", "init")


def test_build_local_issue_bundle_omits_runner_artifacts_path(tmp_path: Path) -> None:
    repo_path = tmp_path / "repo"
    output_dir = tmp_path / "out"
    output_dir.mkdir()
    _create_repo(repo_path)

    bundle = build_local_issue_bundle(
        repo_path=repo_path,
        title="Local issue",
        body="Body",
        issue_number=1,
        repo_full_name_value=None,
        output_dir=output_dir,
    )

    assert "materialization" not in bundle.input
    assert "artifact_paths" not in bundle.input
    assert (bundle.local_root_path / "workspace.snapshot.tar").is_file()


def test_build_local_issue_bundle_preserves_review_intent_selection(
    tmp_path: Path,
) -> None:
    repo_path = tmp_path / "repo"
    output_dir = tmp_path / "out"
    output_dir.mkdir()
    _create_repo(repo_path)

    bundle = build_local_issue_bundle(
        repo_path=repo_path,
        title="Local issue",
        body="Body",
        issue_number=1,
        repo_full_name_value=None,
        output_dir=output_dir,
        review_objective="audit",
        repair_mode="no-test-changes",
    )

    assert bundle.input["review_intent"] == {
        "objective": "audit",
        "repair_mode": "no-test-changes",
    }


def test_build_local_issue_bundle_creates_limited_history_workspace(
    tmp_path: Path,
) -> None:
    repo_path = tmp_path / "repo"
    output_dir = tmp_path / "out"
    output_dir.mkdir()
    _create_repo(repo_path)
    (repo_path / "app.py").write_text("print('ok')\n", encoding="utf-8")
    _run_git(repo_path, "add", "app.py")
    _run_git(repo_path, "commit", "-m", "add app")
    head_sha = _run_git(repo_path, "rev-parse", "HEAD")

    bundle = build_local_issue_bundle(
        repo_path=repo_path,
        title="Local issue",
        body="Body",
        issue_number=1,
        repo_full_name_value=None,
        output_dir=output_dir,
    )

    workspace_path = bundle.local_root_path / "workspace"
    workspace_head = _run_git(workspace_path, "rev-parse", "HEAD")
    reachable_commits = _run_git(workspace_path, "rev-list", "--count", "HEAD")
    is_shallow = _run_git(workspace_path, "rev-parse", "--is-shallow-repository")

    assert workspace_head == head_sha
    assert reachable_commits == "1"
    assert is_shallow == "true"
    assert (workspace_path / ".git").is_dir()
    assert (workspace_path / "app.py").exists()


def test_local_issue_strategy_result_path_uses_strategy_suffix(tmp_path: Path) -> None:
    bundle = ReviewBundle(
        workflow="issue-review",
        run_id="run-1",
        input={},
        local_root_path=tmp_path,
        artifact_root_path=tmp_path / "artifacts",
        issue_strategy="two-stage",
    )

    assert result_path_for_bundle(bundle) == (
        tmp_path / "issue-review.two-stage-result.json"
    )


def test_default_local_output_dir_uses_configured_input_bundle_root(
    tmp_path: Path,
) -> None:
    with patch.dict(
        os.environ,
        {"SEC_REVIEW_INPUT_BUNDLE_ROOT": str(tmp_path)},
        clear=False,
    ):
        assert default_local_output_dir() == tmp_path
