"""Safe extraction for immutable tar+zstd artifacts."""

import shutil
import tarfile
from pathlib import Path


def extract_archive(
    archive_path: Path,
    destination: Path,
    *,
    maximum_entries: int,
    maximum_extracted_bytes: int,
) -> Path:
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    resolved_destination = destination.resolve()
    with tarfile.open(archive_path, mode="r:zst") as archive:
        members = archive.getmembers()
        if len(members) > maximum_entries:
            raise ValueError("Artifact archive exceeds the entry count limit.")
        extracted_size = 0
        for member in members:
            if member.isdev() or member.issym() or member.islnk():
                raise ValueError(
                    f"Artifact archive contains unsafe entry: {member.name}"
                )
            if member.isfile():
                extracted_size += member.size
                if extracted_size > maximum_extracted_bytes:
                    raise ValueError(
                        "Artifact archive exceeds the extracted size limit."
                    )
            candidate = (destination / member.name).resolve()
            try:
                candidate.relative_to(resolved_destination)
            except ValueError as error:
                raise ValueError(
                    f"Artifact archive path escapes its destination: {member.name}"
                ) from error
        archive.extractall(destination, filter="data")
    return destination


__all__ = ["extract_archive"]
