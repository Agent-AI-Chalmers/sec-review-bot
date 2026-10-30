"""Safe extraction for immutable tar+zstd artifacts."""

import shutil
import tarfile
from collections.abc import Callable, Generator
from contextlib import contextmanager
from pathlib import Path

from sec_review_agents.artifacts.tar_zstd import (
    TarEnvelopeEntry,
    read_restricted_pax_envelope,
)

ArchiveProfileValidator = Callable[[tuple[TarEnvelopeEntry, ...]], None]
ArchiveContentsValidator = Callable[
    [tuple[TarEnvelopeEntry, ...], tarfile.TarFile], None
]


def validate_safe_archive_paths(entries: tuple[TarEnvelopeEntry, ...]) -> None:
    """Reject paths whose extraction meaning is unsafe or non-canonical."""
    for entry in entries:
        path = entry.path
        is_directory = entry.type_flag == b"5"
        if (
            not path
            or path.startswith("/")
            or "\\" in path
            or "\0" in path
            or is_directory != path.endswith("/")
        ):
            raise ValueError(f"Artifact archive path is unsafe: {path}")
        value = path[:-1] if is_directory else path
        if any(part in {"", ".", ".."} for part in value.split("/")):
            raise ValueError(f"Artifact archive path is unsafe: {path}")


@contextmanager
def _validated_archive(
    archive_path: Path,
    *,
    maximum_entries: int,
    maximum_extracted_bytes: int,
    validate_profile: ArchiveProfileValidator | None = None,
    validate_contents: ArchiveContentsValidator | None = None,
) -> Generator[tarfile.TarFile]:
    """Own the descriptor from envelope validation through content use."""
    with archive_path.open("rb") as source:
        entries = read_restricted_pax_envelope(
            source,
            maximum_entries=maximum_entries,
            maximum_extracted_bytes=maximum_extracted_bytes,
        )
        validate_safe_archive_paths(entries)
        if validate_profile is not None:
            validate_profile(entries)
        source.seek(0)
        with tarfile.open(name=None, fileobj=source, mode="r:zst") as archive:
            if validate_contents is not None:
                validate_contents(entries, archive)
            yield archive


def validate_archive(
    archive_path: Path,
    *,
    maximum_entries: int,
    maximum_extracted_bytes: int,
    validate_profile: ArchiveProfileValidator | None = None,
    validate_contents: ArchiveContentsValidator | None = None,
) -> None:
    """Validate one archive without exposing its reader lifecycle to the caller."""
    with _validated_archive(
        archive_path,
        maximum_entries=maximum_entries,
        maximum_extracted_bytes=maximum_extracted_bytes,
        validate_profile=validate_profile,
        validate_contents=validate_contents,
    ):
        pass


def extract_archive(
    archive_path: Path,
    destination: Path,
    *,
    maximum_entries: int,
    maximum_extracted_bytes: int,
    validate_profile: ArchiveProfileValidator | None = None,
    validate_contents: ArchiveContentsValidator | None = None,
) -> Path:
    """Validate and extract one immutable archive through a single open file.

    Keeping the descriptor open binds extraction to the bytes that passed envelope,
    budget, path, and optional profile validation even if the archive path changes.
    """
    with _validated_archive(
        archive_path,
        maximum_entries=maximum_entries,
        maximum_extracted_bytes=maximum_extracted_bytes,
        validate_profile=validate_profile,
        validate_contents=validate_contents,
    ) as archive:
        if destination.exists():
            shutil.rmtree(destination)
        destination.mkdir(parents=True)
        archive.extractall(destination, filter="data")
    return destination


__all__ = ["extract_archive", "validate_archive", "validate_safe_archive_paths"]
