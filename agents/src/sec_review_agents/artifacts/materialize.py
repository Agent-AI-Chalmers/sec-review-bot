"""Resolve shared artifact references to verified local objects."""

import hashlib
from pathlib import Path

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.artifacts.s3_adapter import download_s3_object
from sec_review_agents.artifacts.uri import parse_artifact_uri, parse_local_artifact_uri


def materialize_verified_artifact_file(
    reference: ArtifactReference,
    *,
    local_destination: Path,
    maximum_bytes: int,
    expected_s3_key: str | None = None,
) -> Path:
    """Return a verified local file, downloading remote content when required.

    ``local_destination`` is where a non-local locator is materialized. A
    ``file:`` reference is verified in place and its existing path is returned
    instead.
    """
    if reference.size_bytes > maximum_bytes:
        raise ValueError("Artifact object exceeds the size limit.")

    parsed = parse_artifact_uri(reference.uri)
    if parsed.scheme == "file":
        artifact_path = parse_local_artifact_uri(reference.uri).resolve()
    elif parsed.scheme == "s3":
        artifact_path = download_s3_object(
            reference.uri,
            local_destination,
            expected_size=reference.size_bytes,
            maximum_size=maximum_bytes,
            expected_key=expected_s3_key,
        ).resolve()
    else:
        raise ValueError(f"Unsupported artifact URI scheme: {parsed.scheme}")

    if not artifact_path.is_file():
        raise ValueError(f"Artifact object not found: {artifact_path}")
    if artifact_path.stat().st_size != reference.size_bytes:
        raise ValueError("Artifact object size does not match reference.")
    digest = hashlib.sha256()
    with artifact_path.open("rb") as artifact_file:
        while chunk := artifact_file.read(1024 * 1024):
            digest.update(chunk)
    if f"sha256:{digest.hexdigest()}" != reference.digest:
        raise ValueError("Artifact object digest does not match reference.")
    return artifact_path


__all__ = ["materialize_verified_artifact_file"]
