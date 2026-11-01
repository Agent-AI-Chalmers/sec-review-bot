"""Helpers for agent-facing Unix-style virtual paths.

These functions operate on slash-separated paths used by agent, container, and
sandbox filesystems. Use pathlib.Path for host filesystem paths.
"""

import posixpath


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
