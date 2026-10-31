"""The repository's paths_ignore rule, shared by every stage that selects files.

Two callers need the same answer to "is this path excluded": discovery, when it builds the scan
set from the window's changed files, and deletion-case construction, which walks the same list.
Keeping one implementation means a repository only has to read its ignore config once, and a
window that deletes an ignored tree is treated the same by both.
"""

import fnmatch
from collections.abc import Sequence
from pathlib import Path
from typing import Any


def normalize_paths_ignore(raw_patterns: Any, *, source: str) -> list[str]:
    """Validate and normalize the serialized paths_ignore value.

    `source` names the payload the value came from so the error points at the caller that
    supplied it rather than at this module.
    """
    if not isinstance(raw_patterns, list):
        raise ValueError(f"{source} requires paths_ignore to be a list.")
    normalized: list[str] = []
    for index, item in enumerate(raw_patterns):
        if not isinstance(item, str):
            raise ValueError(f"{source} requires paths_ignore[{index}] to be a string.")
        pattern = item.strip().replace("\\", "/")
        if not pattern:
            raise ValueError(
                f"{source} requires paths_ignore[{index}] to be non-empty."
            )
        normalized.append(pattern)
    return normalized


def matches_paths_ignore(relative_path: Path, patterns: Sequence[str]) -> bool:
    """Return whether a workspace-relative path is excluded by the patterns.

    A glob-free pattern excludes the path itself and everything below it, so "vendor" covers
    the whole directory. Glob patterns are matched against the full path and, unless they are
    already anchored with `**/`, against the path suffix, so `*.min.js` excludes a minified
    bundle at any depth.
    """
    normalized_path = relative_path.as_posix()
    for pattern in patterns:
        normalized_pattern = pattern.replace("\\", "/")
        if (
            "*" not in normalized_pattern
            and "?" not in normalized_pattern
            and (
                normalized_path == normalized_pattern
                or normalized_path.startswith(f"{normalized_pattern}/")
            )
        ):
            return True
        if fnmatch.fnmatch(normalized_path, normalized_pattern):
            return True
        if not normalized_pattern.startswith("**/") and fnmatch.fnmatch(
            normalized_path, f"**/{normalized_pattern}"
        ):
            return True
    return False


__all__ = ["matches_paths_ignore", "normalize_paths_ignore"]
