import subprocess
import tempfile
from collections.abc import Sequence
from pathlib import Path

from pydantic import BaseModel

from sec_review_agents.workspace.file_changes import DeletedFileChange, UpsertFileChange
from sec_review_agents.workspace.paths import normalize_declared_file_path
from sec_review_agents.workspace.snapshots import restore_workspace_from_snapshot_tar


def normalize_declared_changed_files(
    declared_changed_files: list[str],
) -> list[str]:
    normalized_paths: list[str] = []
    seen: set[str] = set()

    for raw_path in declared_changed_files:
        normalized = normalize_declared_file_path(str(raw_path or ""))
        if not normalized:
            raise ValueError(
                "declared_changed_files entries must name repository files."
            )
        if normalized in seen:
            continue
        seen.add(normalized)
        normalized_paths.append(normalized)

    return normalized_paths


def _list_untracked_paths(workspace_path: Path) -> list[str]:
    process = subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard", "-z"],
        cwd=workspace_path,
        capture_output=True,
        text=False,
        check=False,
    )
    if process.returncode != 0:
        return []

    return [
        value.decode("utf-8", errors="ignore")
        for value in (process.stdout or b"").split(b"\x00")
        if value
    ]


def _run_git_with_path_batches(
    workspace_path: Path, base_args: list[str], paths: list[str], batch_size: int = 200
) -> None:
    if not paths:
        return

    for index in range(0, len(paths), batch_size):
        chunk = paths[index : index + batch_size]
        process = subprocess.run(
            ["git", *base_args, "--", *chunk],
            cwd=workspace_path,
            capture_output=True,
            text=True,
            check=False,
        )
        if process.returncode != 0:
            raise RuntimeError(
                process.stderr.strip()
                or "git command failed while preparing workspace patch"
            )


def _filter_paths(paths: Sequence[str] | None) -> list[str]:
    filtered: list[str] = []
    seen: set[str] = set()
    for path in paths or []:
        normalized = normalize_declared_file_path(path)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        filtered.append(normalized)
    return filtered


def _path_matches_any(path: str, include_paths: list[str]) -> bool:
    return any(
        path == include_path or path.startswith(f"{include_path}/")
        for include_path in include_paths
    )


def _build_git_workspace_patch(
    workspace_path: Path, *, include_paths: Sequence[str] | None = None
) -> tuple[str, list[str]]:
    """Run Git diff and return its patch text and observed repository paths.

    An empty scope observes the whole workspace. Untracked files are temporarily
    marked intent-to-add, then reset before this function returns.
    """
    scoped_paths = _filter_paths(include_paths)
    untracked_paths = _list_untracked_paths(workspace_path)
    if scoped_paths:
        untracked_paths = [
            path for path in untracked_paths if _path_matches_any(path, scoped_paths)
        ]

    scope_args = ["--", *scoped_paths] if scoped_paths else []

    try:
        if untracked_paths:
            _run_git_with_path_batches(
                workspace_path,
                ["add", "--intent-to-add"],
                untracked_paths,
            )

        process = subprocess.run(
            [
                "git",
                "diff",
                # Keep persisted patch artifacts free of ANSI color escapes.
                "--no-color",
                "--binary",
                "--no-ext-diff",
                # Do not let git collapse delete+add into a rename.
                # file_changes publishes final path actions: delete old, upsert new.
                "--no-renames",
                "--src-prefix=a/",
                "--dst-prefix=b/",
                "HEAD",
                *scope_args,
            ],
            cwd=workspace_path,
            capture_output=True,
            text=True,
            check=False,
        )
        if process.returncode != 0:
            raise RuntimeError(
                process.stderr.strip()
                or "git diff failed while building workspace.patch"
            )

        # Changed files come straight from git (NUL-separated, repository-relative)
        # rather than re-parsing the patch text. Text parsing is ambiguous for bare
        # paths containing spaces or a ` b/` substring and cannot see mode-only
        # changes; `--name-only -z` reports the exact paths git acted on.
        names_process = subprocess.run(
            [
                "git",
                "diff",
                "--name-only",
                "-z",
                "--no-color",
                "--no-ext-diff",
                "--no-renames",
                "HEAD",
                *scope_args,
            ],
            cwd=workspace_path,
            capture_output=True,
            text=False,
            check=False,
        )
        if names_process.returncode != 0:
            raise RuntimeError(
                names_process.stderr.decode("utf-8", errors="ignore").strip()
                or "git diff --name-only failed while building workspace.patch"
            )
        changed_files = [
            value.decode("utf-8", errors="ignore")
            for value in (names_process.stdout or b"").split(b"\x00")
            if value
        ]

        return process.stdout or "", changed_files
    finally:
        if untracked_paths:
            _run_git_with_path_batches(
                workspace_path,
                ["reset", "-q"],
                untracked_paths,
            )


def build_workspace_patch(
    worktree_path: Path,
    *,
    include_paths: Sequence[str],
) -> dict:
    """Build, but do not persist, the patch for explicitly declared paths.

    Runtime acceptance and artifact construction share this export policy. The
    returned paths are Git-observed changes within ``include_paths``. An empty
    declared scope returns an empty patch instead of exporting the whole workspace.
    """
    # `include_paths=[]` means "the agent declared no publishable changed paths".
    # Keep the emitted patch empty so undeclared workspace edits never become
    # publishable patch content.
    if not (worktree_path / ".git").exists():
        raise RuntimeError(
            "Workspace patch export requires a git-initialized workspace."
        )

    scoped_paths = _filter_paths(include_paths)
    if scoped_paths:
        patch_content, changed_files = _build_git_workspace_patch(
            worktree_path, include_paths=scoped_paths
        )
    else:
        patch_content, changed_files = "", []
    return {
        "patch_content": patch_content,
        "changed_files": changed_files,
    }


def check_workspace_patch_applies_to_fresh_baseline(
    baseline_snapshot_tar_path: Path,
    patch_content: str,
) -> str | None:
    if not str(patch_content or "").strip():
        return None

    with tempfile.TemporaryDirectory(prefix="sec-review-patch-apply-") as tempdir:
        fresh_workspace = Path(tempdir) / "workspace"
        restore_workspace_from_snapshot_tar(
            tar_path=baseline_snapshot_tar_path,
            destination_path=fresh_workspace,
        )
        process = subprocess.run(
            ["git", "apply", "--check", "-p1"],
            cwd=fresh_workspace,
            input=patch_content,
            capture_output=True,
            text=True,
            check=False,
        )
        if process.returncode == 0:
            return None
        return (
            process.stderr.strip()
            or process.stdout.strip()
            or "git apply --check failed for the generated workspace patch"
        )


class PatchArtifact(BaseModel):
    """Review diff and publishable final contents exported from one workspace scope.

    File changes are authoritative for applying the patch; the diff is for review.
    Keeping both together ensures synthesis and repair stages consume the same
    export rather than reconstructing file contents from diff text.
    """

    patch_diff: str
    file_changes: list[DeletedFileChange | UpsertFileChange]


def build_patch_artifact(
    workspace_path: Path,
    *,
    include_paths: Sequence[str],
) -> PatchArtifact:
    """Build review diff and final-file changes from the same workspace paths."""
    from sec_review_agents.workspace.file_changes import (
        collect_publishable_file_changes,
    )

    workspace_patch = build_workspace_patch(
        workspace_path,
        include_paths=include_paths,
    )
    file_changes = collect_publishable_file_changes(
        workspace_path,
        workspace_patch["changed_files"],
    )

    return PatchArtifact(
        patch_diff=workspace_patch["patch_content"], file_changes=file_changes
    )


def observe_workspace_changed_files(worktree_path: Path) -> list[str]:
    if not (worktree_path / ".git").exists():
        raise RuntimeError(
            "Workspace change observation requires a git-initialized workspace."
        )

    # Observation is diagnostic: publishable patch export still requires an explicit scope.
    _, changed_files = _build_git_workspace_patch(worktree_path, include_paths=None)
    return changed_files
