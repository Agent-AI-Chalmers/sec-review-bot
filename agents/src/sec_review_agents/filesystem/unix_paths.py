"""Helpers for agent-facing Unix-style virtual paths.

These functions operate on slash-separated paths used by agent, container, and
sandbox filesystems. Use pathlib.Path for host filesystem paths.
"""

import fnmatch
import posixpath
from pathlib import PurePosixPath


def normalize_unix_path(path: str) -> str:
    normalized = posixpath.normpath(path or "/")
    if not normalized.startswith("/"):
        normalized = "/" + normalized
    return normalized


def unix_path_has_prefix(path: str, prefix: str) -> bool:
    normalized_path = normalize_unix_path(path)
    normalized_prefix = normalize_unix_path(prefix)
    return normalized_path == normalized_prefix or normalized_path.startswith(
        normalized_prefix + "/"
    )


def is_absolute_unix_path(path: str) -> bool:
    return path.startswith("/")


def normalize_glob_pattern(pattern: str | None) -> str:
    normalized = str(pattern or "*").lstrip("/")
    return normalized or "*"


def matches_glob_pattern(relative_path: str, pattern: str) -> bool:
    """Match a relative Unix path against an agent-facing glob pattern.

    Treat ``**/*.py`` as matching both ``a.py`` and ``pkg/a.py`` so local
    traversal follows the glob behavior agents expect.
    """
    path = PurePosixPath(relative_path)
    if path.match(pattern) or fnmatch.fnmatch(relative_path, pattern):
        return True
    if pattern.startswith("**/"):
        root_pattern = pattern[3:]
        return path.match(root_pattern) or fnmatch.fnmatch(relative_path, root_pattern)
    return False
