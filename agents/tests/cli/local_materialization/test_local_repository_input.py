import subprocess
from pathlib import Path
from unittest.mock import patch
from urllib.parse import unquote, urlsplit

import pytest

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.cli.local_materialization.repository import (
    _build_changed_files,
    build_local_repository_security_bundle,
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


def test_build_changed_files_reports_copied_with_its_source() -> None:
    with patch(
        "sec_review_agents.cli.local_materialization.repository.subprocess.run",
        return_value=subprocess.CompletedProcess(
            args=["git", "diff"],
            returncode=0,
            stdout="C100\told.py\tnew.py\n",
            stderr="",
        ),
    ):

        entries = _build_changed_files(Path("/repo"), "base", "head")

    # `copied` is part of the contract's change vocabulary, so it keeps its own name instead of
    # collapsing into `modified`, and the source path travels with it.
    assert entries == [
        {
            "path": "new.py",
            "status": "copied",
            "previous_path": "old.py",
        }
    ]


def test_repository_bundle_does_not_include_repository_identity(tmp_path: Path) -> None:
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

    bundle = build_local_repository_security_bundle(
        repo_path=repo_path,
        output_dir=output_dir,
        ref="main",
        scan_mode="full",
    )

    assert "repository" not in bundle.input
    assert "repo_full_name" not in bundle.input["scan_target"]


def test_full_repository_bundle_creates_limited_history_workspace(
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
    (repo_path / "app.py").write_text("print('ok')\n", encoding="utf-8")
    _run_git(repo_path, "add", "app.py")
    _run_git(repo_path, "commit", "-m", "add app")
    head_sha = _run_git(repo_path, "rev-parse", "HEAD")

    bundle = build_local_repository_security_bundle(
        repo_path=repo_path,
        output_dir=output_dir,
        ref="main",
        scan_mode="full",
    )

    assert not (bundle.local_root_path / "workspace").exists()
    reference = ArtifactReference.from_mapping(bundle.input["input_bundle"])
    parsed_uri = urlsplit(reference.uri)
    assert parsed_uri.scheme == "file"
    assert Path(unquote(parsed_uri.path)).is_file()
    assert head_sha


def test_incremental_bundle_rejects_non_ancestor_baseline(tmp_path: Path) -> None:
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

    _run_git(repo_path, "checkout", "-b", "feature")
    (repo_path / "feature.py").write_text("print('feature')\n", encoding="utf-8")
    _run_git(repo_path, "add", "feature.py")
    _run_git(repo_path, "commit", "-m", "feature")
    feature_sha = _run_git(repo_path, "rev-parse", "HEAD")

    _run_git(repo_path, "checkout", "main")
    (repo_path / "main.py").write_text("print('main')\n", encoding="utf-8")
    _run_git(repo_path, "add", "main.py")
    _run_git(repo_path, "commit", "-m", "main")
    main_sha = _run_git(repo_path, "rev-parse", "HEAD")

    with pytest.raises(ValueError, match="baseline is not an ancestor"):
        build_local_repository_security_bundle(
            repo_path=repo_path,
            output_dir=output_dir,
            ref=feature_sha,
            scan_mode="incremental",
            baseline_ref=main_sha,
        )


def test_repository_bundle_preserves_paths_ignore_patterns(tmp_path: Path) -> None:
    """Local runs must pass caller-selected exclusions to repository discovery."""
    repo_path = tmp_path / "repo"
    output_dir = tmp_path / "out"
    repo_path.mkdir()
    output_dir.mkdir()

    _run_git(repo_path, "init", "-b", "main")
    _run_git(repo_path, "config", "user.name", "Test User")
    _run_git(repo_path, "config", "user.email", "test@example.com")
    (repo_path / "app.py").write_text("print('ok')\n", encoding="utf-8")
    _run_git(repo_path, "add", "app.py")
    _run_git(repo_path, "commit", "-m", "init")

    bundle = build_local_repository_security_bundle(
        repo_path=repo_path,
        output_dir=output_dir,
        paths_ignore=["docs", "**/*.generated.py"],
    )

    assert bundle.input["scan_scope"]["paths_ignore"] == [
        "docs",
        "**/*.generated.py",
    ]
    assert bundle.input["scan_target"]["event_type"] == "manual"
