import subprocess
from pathlib import Path

import pytest

from sec_review_agents.cli.local_materialization.pull_request import (
    _parse_name_status_records,
    build_local_pull_request_bundle,
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


def test_parse_name_status_records_handles_regular_and_rename_entries() -> None:
    entries = _parse_name_status_records("M\0app.py\0R100\0old.py\0new.py\0")

    assert entries == [
        {
            "raw_status": "M",
            "status": "modified",
            "path": "app.py",
            "previous_path": None,
        },
        {
            "raw_status": "R100",
            "status": "renamed",
            "path": "new.py",
            "previous_path": "old.py",
        },
    ]


def test_parse_name_status_records_rejects_truncated_entries() -> None:
    with pytest.raises(ValueError):
        _parse_name_status_records("R100\0old.py\0")


def test_build_local_pull_request_bundle_creates_limited_history_workspace(
    tmp_path: Path,
) -> None:
    repo_path = tmp_path / "repo"
    output_dir = tmp_path / "out"
    repo_path.mkdir()
    output_dir.mkdir()

    _run_git(repo_path, "init", "-b", "main")
    _run_git(repo_path, "config", "user.name", "Test User")
    _run_git(repo_path, "config", "user.email", "test@example.com")
    (repo_path / "README.md").write_text("# test\n", encoding="utf-8")
    _run_git(repo_path, "add", "README.md")
    _run_git(repo_path, "commit", "-m", "init")
    base_sha = _run_git(repo_path, "rev-parse", "HEAD")

    (repo_path / "app.py").write_text("print('ok')\n", encoding="utf-8")
    _run_git(repo_path, "add", "app.py")
    _run_git(repo_path, "commit", "-m", "add app")
    head_sha = _run_git(repo_path, "rev-parse", "HEAD")

    bundle = build_local_pull_request_bundle(
        repo_path=repo_path,
        title="Local PR",
        body="Body",
        pr_number=1,
        repo_full_name_value=None,
        output_dir=output_dir,
        base_ref=base_sha,
        head_ref=head_sha,
    )

    workspace_path = bundle.local_root_path / "workspace"
    assert (workspace_path / ".git").exists()
    assert _run_git(workspace_path, "rev-parse", "HEAD") == head_sha
    assert (workspace_path / "app.py").exists()
