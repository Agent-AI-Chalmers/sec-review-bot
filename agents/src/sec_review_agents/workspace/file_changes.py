"""Publishable final-file snapshots for app-side PR creation.

`file_changes` is intentionally simpler than a git diff: each entry says that a
repository path should be deleted or upserted with final content. Renames are
represented as delete old path + upsert new path. Modes distinguish regular Git
blobs (`100644`, `100755`) from symbolic links (`120000`), whose content is the link target, never the referenced file.
"""

import base64
from collections.abc import Mapping, Sequence
from typing import Any, Literal, NotRequired, TypedDict

# These PEP 695 aliases are resolved during typed decoding by Pydantic's
# TypeAdapter, which our shared Temporal client uses via pydantic_data_converter.
# The default converter's value_to_type path cannot decode this nested alias
# shape; expanding annotations was its workaround, not a JSON format requirement.
# Alias names are not stored in JSON. Keep the configured converter and verify
# typed decoding, not just encoding (tests/delivery_stages/execution/test_temporal_input.py).
type ContentEncoding = Literal["utf-8", "base64"]
type FileMode = Literal["100644", "100755", "120000"]


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
