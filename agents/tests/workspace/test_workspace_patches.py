import pytest

from sec_review_agents.workspace.patches import (
    normalize_declared_changed_files,
    persist_workspace_patch,
)
from sec_review_agents.workspace.paths import normalize_workspace_file_path


def test_normalize_declared_changed_files_deduplicates_normalized_path() -> None:
    assert normalize_declared_changed_files(["a/src/app.py", "src/app.py"]) == [
        "src/app.py"
    ]


def test_normalize_declared_changed_files_rejects_empty_path() -> None:
    with pytest.raises(ValueError, match="must name repository files"):
        normalize_declared_changed_files(["/workspace"])


@pytest.mark.parametrize(
    "path",
    ("../secret.txt", "a/../secret.txt", "/workspace/../secret.txt"),
)
def test_normalize_workspace_file_path_rejects_workspace_escape(path: str) -> None:
    with pytest.raises(ValueError, match="must not escape"):
        normalize_workspace_file_path(path)


@pytest.mark.parametrize(
    "path",
    (
        ".git/config",
        "a/.git/config",
        "/workspace/.git/config",
        "src/.git/config",
    ),
)
def test_normalize_workspace_file_path_rejects_git_paths(path: str) -> None:
    with pytest.raises(ValueError, match="must not target .git"):
        normalize_workspace_file_path(path)


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
