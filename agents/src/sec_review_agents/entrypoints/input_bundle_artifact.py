"""Validation for the input-bundle tar+zstd artifact profile."""

from pathlib import Path, PurePosixPath

from sec_review_agents.artifacts.archive import validate_safe_archive_paths
from sec_review_agents.artifacts.tar_zstd import (
    TarEnvelopeEntry,
    validate_restricted_pax_archive,
)
from sec_review_agents.contract_versions import INPUT_BUNDLE_ARTIFACT_VERSION

INPUT_BUNDLE_MANIFEST_NAME = "manifest.json"
INPUT_BUNDLE_WORKSPACE_SNAPSHOT = "workspace.snapshot.tar"


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


def validate_input_bundle_entries(entries: tuple[TarEnvelopeEntry, ...]) -> None:
    """Validate the input-bundle profile after shared envelope validation."""
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


def validate_input_bundle_archive(
    archive_path: Path,
    *,
    maximum_entries: int | None = None,
    maximum_extracted_bytes: int | None = None,
) -> tuple[TarEnvelopeEntry, ...]:
    """Validate the shared envelope and input-bundle profile without extracting."""
    entries = validate_restricted_pax_archive(
        archive_path,
        maximum_entries=maximum_entries,
        maximum_extracted_bytes=maximum_extracted_bytes,
    )
    validate_safe_archive_paths(entries)
    validate_input_bundle_entries(entries)
    return entries


__all__ = [
    "INPUT_BUNDLE_ARTIFACT_VERSION",
    "validate_input_bundle_archive",
    "validate_input_bundle_entries",
]
