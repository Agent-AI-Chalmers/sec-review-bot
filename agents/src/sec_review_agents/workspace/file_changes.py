"""Publishable final-file snapshots for app-side PR creation.

`file_changes` is intentionally simpler than a git diff: each entry says that a
repository path should be deleted or upserted with final content. Renames are
represented as delete old path + upsert new path. Modes are limited to regular
Git blobs (`100644` and `100755`); symlink entries are not part of this contract.
"""

import base64
import stat
from collections.abc import Sequence
from pathlib import Path
from typing import Any, TypedDict

from sec_review_agents.workspace.paths import normalize_workspace_file_path

FILE_MODE_REGULAR = "100644"
FILE_MODE_EXECUTABLE = "100755"


class FileChange(TypedDict, total=False):
    path: str
    status: str
    content: str
    content_encoding: str
    mode: str


def encode_file_content(content_buffer: bytes) -> dict[str, str]:
    if b"\x00" not in content_buffer:
        try:
            return {
                "content": content_buffer.decode("utf-8"),
                "content_encoding": "utf-8",
            }
        except UnicodeDecodeError:
            pass

    return {
        "content": base64.b64encode(content_buffer).decode("ascii"),
        "content_encoding": "base64",
    }


def git_blob_mode(path: Path) -> str:
    executable_bits = stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
    if path.stat().st_mode & executable_bits:
        return FILE_MODE_EXECUTABLE
    return FILE_MODE_REGULAR


def collect_publishable_file_changes(
    workspace_path: Path, changed_files: Sequence[Any] | None
) -> list[FileChange]:
    workspace_root_resolved = workspace_path.resolve()
    file_changes: list[FileChange] = []
    seen: set[str] = set()

    for raw_path in changed_files or []:
        normalized_path = normalize_workspace_file_path(str(raw_path or ""))
        if not normalized_path or normalized_path in seen:
            continue
        seen.add(normalized_path)

        absolute_path = (workspace_path / normalized_path).resolve()
        try:
            absolute_path.relative_to(workspace_root_resolved)
        except ValueError:
            continue

        if not absolute_path.exists():
            file_changes.append(
                {
                    "path": normalized_path,
                    "status": "deleted",
                }
            )
            continue

        if not absolute_path.is_file():
            continue

        encoded_content = encode_file_content(absolute_path.read_bytes())
        file_change: FileChange = {
            "path": normalized_path,
            "status": "upsert",
            "mode": git_blob_mode(absolute_path),
            "content": encoded_content["content"],
            "content_encoding": encoded_content["content_encoding"],
        }
        file_changes.append(file_change)

    return file_changes
