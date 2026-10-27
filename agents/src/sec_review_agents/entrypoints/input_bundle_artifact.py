"""Validation for the input-bundle tar+zstd artifact profile."""

from pathlib import Path, PurePosixPath

from sec_review_agents.artifacts.tar_zstd import (
    TarEnvelopeEntry,
    validate_restricted_pax_archive,
)
from sec_review_agents.contract_versions import INPUT_BUNDLE_ARTIFACT_VERSION

INPUT_BUNDLE_MANIFEST_NAME = "manifest.json"
INPUT_BUNDLE_WORKSPACE_SNAPSHOT = "workspace.snapshot.tar"


def _canonical_path(entry: TarEnvelopeEntry) -> bool:
    path = entry.path
    is_directory = entry.type_flag == b"5"
    if not path or path.startswith("/") or "\\" in path or "\0" in path:
        return False
    if is_directory != path.endswith("/"):
        return False
    value = path[:-1] if is_directory else path
    parts = value.split("/")
    return all(part not in {"", ".", ".."} for part in parts)


def _allowed_path(entry: TarEnvelopeEntry) -> bool:
    if entry.path in {INPUT_BUNDLE_MANIFEST_NAME, INPUT_BUNDLE_WORKSPACE_SNAPSHOT}:
        return entry.type_flag == b"0"
    for root in ("history/", "incremental-window/"):
        if entry.path == root:
            return entry.type_flag == b"5"
        if entry.path.startswith(root):
            return entry.type_flag in {b"0", b"5"}
    return False


def _require_parent_directories(entries: tuple[TarEnvelopeEntry, ...]) -> None:
    paths = {entry.path for entry in entries}
    for entry in entries:
        value = entry.path.removesuffix("/")
        parent = PurePosixPath(value).parent
        while str(parent) != ".":
            if f"{parent.as_posix()}/" not in paths:
                raise ValueError(
                    f"Input bundle archive omits parent directory for {entry.path}."
                )
            parent = parent.parent


def validate_input_bundle_archive(
    archive_path: Path,
) -> tuple[TarEnvelopeEntry, ...]:
    """Validate profile-level structure before any archive member is extracted."""
    entries = validate_restricted_pax_archive(archive_path)
    if not entries or entries[0].path != INPUT_BUNDLE_MANIFEST_NAME:
        raise ValueError("Input bundle manifest must be the first archive entry.")

    seen: set[str] = set()
    previous: bytes | None = None
    for index, entry in enumerate(entries):
        if entry.path in seen:
            raise ValueError(
                f"Input bundle archive contains duplicate path: {entry.path}"
            )
        seen.add(entry.path)
        if not _canonical_path(entry):
            raise ValueError(
                f"Input bundle archive path is not canonical: {entry.path}"
            )
        if not _allowed_path(entry):
            raise ValueError(f"Input bundle archive path is not allowed: {entry.path}")
        encoded = entry.path.encode("utf-8")
        if index > 1 and previous is not None and encoded <= previous:
            raise ValueError("Input bundle archive entries are not in canonical order.")
        if index > 0:
            previous = encoded

    required = {
        INPUT_BUNDLE_MANIFEST_NAME,
        INPUT_BUNDLE_WORKSPACE_SNAPSHOT,
        "history/",
    }
    missing = required - seen
    if missing:
        raise ValueError(
            f"Input bundle archive is missing required path: {min(missing)}"
        )
    _require_parent_directories(entries)
    return entries


__all__ = [
    "INPUT_BUNDLE_ARTIFACT_VERSION",
    "validate_input_bundle_archive",
]
