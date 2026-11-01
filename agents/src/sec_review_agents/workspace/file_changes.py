"""Publishable final-file snapshots for app-side PR creation.

`file_changes` is intentionally simpler than a git diff: each entry says that a
repository path should be deleted or upserted with final content. Renames are
represented as delete old path + upsert new path. Modes distinguish regular Git
blobs (`100644`, `100755`) from symbolic links (`120000`), whose content is the link target, never the referenced file.
"""

import base64
import os
import stat
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Literal, NotRequired, TypedDict

from sec_review_agents.workspace.paths import validate_repository_file_path

# These PEP 695 aliases are resolved during typed decoding by Pydantic's
# TypeAdapter, which our shared Temporal client uses via pydantic_data_converter.
# The default converter's value_to_type path cannot decode this nested alias
# shape; expanding annotations was its workaround, not a JSON format requirement.
# Alias names are not stored in JSON. Keep the configured converter and verify
# typed decoding, not just encoding (tests/delivery_stages/execution/test_temporal_input.py).
type ContentEncoding = Literal["utf-8", "base64"]
type FileMode = Literal["100644", "100755", "120000"]

FILE_MODE_REGULAR: FileMode = "100644"
FILE_MODE_EXECUTABLE: FileMode = "100755"


class EncodedFileContent(TypedDict):
    content: str
    content_encoding: ContentEncoding


class DeletedFileChange(TypedDict):
    path: str
    status: Literal["deleted"]


class UpsertFileChange(TypedDict):
    path: str
    status: Literal["upsert"]
    content: str
    content_encoding: ContentEncoding
    mode: NotRequired[FileMode]


type FileChange = DeletedFileChange | UpsertFileChange


def file_change_paths(file_changes: Sequence[Mapping[str, Any]] | None) -> list[str]:
    """Return the ordered unique paths represented by final-file changes."""
    paths: list[str] = []
    seen: set[str] = set()
    for item in file_changes or []:
        path = item.get("path")
        if isinstance(path, str) and path and path not in seen:
            seen.add(path)
            paths.append(path)
    return paths


def encode_file_content(content_buffer: bytes) -> EncodedFileContent:
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


def git_blob_mode(path: Path) -> FileMode:
    if path.is_symlink():
        return "120000"
    executable_bits = stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
    if path.stat().st_mode & executable_bits:
        return FILE_MODE_EXECUTABLE
    return FILE_MODE_REGULAR


def collect_publishable_file_changes(
    workspace_path: Path,
    changed_files: Sequence[Any] | None,
    *,
    deleted_paths: Sequence[str] = (),
) -> list[FileChange]:
    workspace_root_resolved = workspace_path.resolve()
    file_changes: list[FileChange] = []
    seen: set[str] = set()
    deleted = set(deleted_paths)

    for raw_path in changed_files or []:
        normalized_path = validate_repository_file_path(raw_path)
        if normalized_path in seen:
            continue
        seen.add(normalized_path)

        # Git deletions refer to baseline entries. The same path may now be a
        # directory, or its parent may have become a file or symbolic link.
        if normalized_path in deleted:
            file_changes.append({"path": normalized_path, "status": "deleted"})
            continue

        absolute_path = workspace_path / normalized_path
        # Inspect the entry itself; resolving it would replace a link with its
        # target contents and misclassify dangling links as deletions.
        parent = absolute_path.parent
        while parent != workspace_path:
            if parent.is_symlink():
                raise ValueError(
                    f"File change traverses a symbolic link: {normalized_path}"
                )
            parent = parent.parent
        if not absolute_path.parent.resolve().is_relative_to(workspace_root_resolved):
            raise ValueError(f"File change escapes workspace: {normalized_path}")

        if absolute_path.is_symlink():
            content = os.fsencode(os.readlink(absolute_path))
        elif absolute_path.is_file():
            content = absolute_path.read_bytes()
        elif absolute_path.exists():
            raise ValueError(
                f"File change is not a file or symbolic link: {normalized_path}"
            )
        else:
            file_changes.append({"path": normalized_path, "status": "deleted"})
            continue

        encoded_content = encode_file_content(content)
        file_change: FileChange = {
            "path": normalized_path,
            "status": "upsert",
            "mode": git_blob_mode(absolute_path),
            "content": encoded_content["content"],
            "content_encoding": encoded_content["content_encoding"],
        }
        file_changes.append(file_change)

    return file_changes
