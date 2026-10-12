import subprocess

import pytest

from sec_review_agents.workspace.patches import (
    normalize_declared_changed_files,
    observe_workspace_changed_files,
    persist_workspace_patch,
)


def _init_git_repo(workspace, files: dict[str, str]) -> None:
    workspace.mkdir()
    for relative, content in files.items():
        path = workspace / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "t@t"],
        cwd=workspace,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "t"],
        cwd=workspace,
        check=True,
        capture_output=True,
    )
    subprocess.run(["git", "add", "-A"], cwd=workspace, check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-qm", "init"],
        cwd=workspace,
        check=True,
        capture_output=True,
    )


def test_normalize_declared_changed_files_preserves_declared_prefix() -> None:
    # A declared path may legitimately start with a top-level a/ or b/ directory;
    # the git diff prefixes must not be stripped from declared paths, or an agent
    # that edits a/x.py and declares a/x.py would silently target x.py instead.
    assert normalize_declared_changed_files(["a/src/app.py", "src/app.py"]) == [
        "a/src/app.py",
        "src/app.py",
    ]


def test_normalize_declared_changed_files_rejects_empty_path() -> None:
    with pytest.raises(ValueError, match="must name repository files"):
        normalize_declared_changed_files(["/workspace"])


def test_normalize_declared_changed_files_strips_only_absolute_workspace_prefix() -> (
    None
):
    # `/workspace/...` is the unambiguous workspace-root spelling and is stripped;
    # a relative `workspace/...` may be a real top-level `workspace/` directory and
    # must not be retargeted.
    assert normalize_declared_changed_files(["/workspace/src/app.py"]) == ["src/app.py"]
    assert normalize_declared_changed_files(["workspace/src/app.py"]) == [
        "workspace/src/app.py"
    ]


def test_observe_workspace_changed_files_reports_spaced_and_mode_only_paths(
    tmp_path,
) -> None:
    """Observation reads paths from `git diff --name-only -z`, so it reports spaced
    names, ` b/` substrings, and mode-only changes that patch-text parsing could
    not recover reliably.
    """
    workspace = tmp_path / "workspace"
    _init_git_repo(workspace, {"a b.txt": "x\n", "foo b/bar.txt": "x\n"})

    # Mode-only change on the spaced path + content change on the ` b/` path.
    (workspace / "a b.txt").chmod(0o755)
    (workspace / "foo b" / "bar.txt").write_text("y\n", encoding="utf-8")

    assert sorted(observe_workspace_changed_files(workspace)) == [
        "a b.txt",
        "foo b/bar.txt",
    ]


def test_persist_workspace_patch_rejects_path_like_artifact_filenames(
    tmp_path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / ".git").mkdir()

    with pytest.raises(ValueError, match="plain file name"):
        persist_workspace_patch(
            workspace,
            patch_root_path=tmp_path / "patches",
            filename="../workspace.patch",
            include_paths=[],
        )


def test_persist_workspace_patch_requires_explicit_include_paths(tmp_path) -> None:
    with pytest.raises(TypeError, match="include_paths"):
        # Intentionally omit include_paths to verify the public helper fails
        # loudly when callers do not choose an explicit patch scope.
        persist_workspace_patch(  # type: ignore[call-arg]
            tmp_path,
            patch_root_path=tmp_path / "patches",
        )
