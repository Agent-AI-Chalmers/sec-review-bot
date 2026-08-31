import subprocess
from pathlib import Path

import pytest

from sec_review_agents.cli.local_git import (
    git_commit_exists,
    git_ref_exists,
    is_likely_git_sha,
    repo_default_branch,
    repo_full_name,
    repo_head_sha,
    resolve_git_ref,
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


def _init_repo(repo_path: Path) -> str:
    repo_path.mkdir()
    _run_git(repo_path, "init", "-b", "main")
    _run_git(repo_path, "config", "user.name", "Test User")
    _run_git(repo_path, "config", "user.email", "test@example.com")
    (repo_path / "README.md").write_text("# test\n", encoding="utf-8")
    _run_git(repo_path, "add", "README.md")
    _run_git(repo_path, "commit", "-m", "init")
    return _run_git(repo_path, "rev-parse", "HEAD")


def test_local_git_helpers_resolve_refs_and_check_commit_existence(
    tmp_path: Path,
) -> None:
    repo_path = tmp_path / "repo"
    head_sha = _init_repo(repo_path)
    blob_sha = _run_git(repo_path, "hash-object", "README.md")
    _run_git(repo_path, "update-ref", "refs/local/readme-blob", blob_sha)

    assert resolve_git_ref(repo_path, "main") == head_sha
    assert resolve_git_ref(repo_path, "missing-ref") == "missing-ref"
    assert git_ref_exists(repo_path, "main")
    assert not git_ref_exists(repo_path, "refs/local/readme-blob")
    assert not git_ref_exists(repo_path, "missing-ref")
    assert git_commit_exists(repo_path, head_sha)
    assert not git_commit_exists(repo_path, "0" * 40)
    assert repo_head_sha(repo_path) == head_sha
    assert repo_default_branch(repo_path) == "main"
    assert repo_full_name(repo_path, "owner/repo") == "owner/repo"
    assert repo_full_name(repo_path, None) == "local/repo"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("abcdef0", True),
        ("ABCDEF0123456789", True),
        ("abcdef", False),
        ("gabcdef", False),
        ("a" * 41, False),
    ],
)
def test_is_likely_git_sha(value: str, expected: bool) -> None:
    assert is_likely_git_sha(value) is expected
