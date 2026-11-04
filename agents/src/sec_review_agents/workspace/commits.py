"""Export repair commits without consulting the mutable index or worktree."""

import subprocess
from pathlib import Path
from typing import cast

from sec_review_agents.workspace.file_changes import (
    FileChange,
    FileMode,
    encode_file_content,
)
from sec_review_agents.workspace.patches import PatchArtifact
from sec_review_agents.workspace.paths import validate_repository_file_path


def _git(workspace: Path, *args: str) -> bytes:
    process = subprocess.run(
        ["git", *args], cwd=workspace, capture_output=True, check=False
    )
    if process.returncode:
        raise RuntimeError(
            process.stderr.decode("utf-8", errors="replace").strip()
            or f"Git command failed: {args[0]}"
        )
    return process.stdout


def resolve_workspace_commit(workspace: Path) -> str:
    return _git(workspace, "rev-parse", "--verify", "HEAD^{commit}").decode().strip()


def build_committed_patch(workspace: Path, *, baseline_commit: str) -> PatchArtifact:
    """Export the net committed repair; no new commit means no deliverable patch.

    The caller pins baseline_commit before setup or agent execution. Final HEAD
    must descend from it; all intervening commits contribute to the net repair.
    Both representations come from the same immutable target tree. Staged and
    unstaged edits are deliberately excluded, including edits to committed files.
    """
    target = resolve_workspace_commit(workspace)
    _git(workspace, "merge-base", "--is-ancestor", baseline_commit, target)
    diff_args = [
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        # Publication represents renames as deletion plus a final-file upsert.
        "--no-renames",
        # Config must not hide unsupported gitlinks from the mode check below.
        "--ignore-submodules=none",
        baseline_commit,
        target,
    ]
    try:
        patch = _git(
            workspace,
            "diff",
            "--binary",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            *diff_args,
        ).decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError(
            "Committed diff contains non-UTF-8 bytes; patch_diff cannot represent it."
        ) from error
    # Raw diff supplies final modes and object IDs alongside exact paths. Read
    # blobs by those IDs instead of rediscovering each entry through ls-tree.
    fields = _git(workspace, "diff", "--raw", "--no-abbrev", "-z", *diff_args).split(
        b"\x00"
    )
    changes: list[FileChange] = []
    for metadata, raw_path in zip(fields[0:-1:2], fields[1::2], strict=True):
        _, mode, _, oid, status = metadata.split()
        path = validate_repository_file_path(raw_path.decode("utf-8"))
        if status == b"D":
            changes.append({"path": path, "status": "deleted"})
            continue
        if mode not in {b"100644", b"100755", b"120000"}:
            raise ValueError(f"Unsupported committed entry: {path}")
        # A symlink blob contains its target bytes; never dereference the worktree.
        content = encode_file_content(
            _git(workspace, "cat-file", "blob", oid.decode("ascii"))
        )
        changes.append(
            {
                "path": path,
                "status": "upsert",
                "mode": cast(FileMode, mode.decode("ascii")),
                "content": content["content"],
                "content_encoding": content["content_encoding"],
            }
        )
    return PatchArtifact(patch_diff=patch, file_changes=changes)
