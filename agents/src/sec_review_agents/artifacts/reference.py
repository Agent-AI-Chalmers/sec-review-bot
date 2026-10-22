"""Immutable artifact references shared by local and object-storage flows."""

import hashlib
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from sec_review_agents.artifacts.input_storage import download_s3_input_bundle

ARCHIVE_MEDIA_TYPE = "application/tar+zstd"
_SHA256_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


@dataclass(frozen=True)
class ArtifactReference:
    uri: str
    digest: str
    media_type: str
    size_bytes: int

    @classmethod
    def from_mapping(cls, value: Any) -> ArtifactReference:
        if not isinstance(value, dict):
            raise ValueError("Artifact reference must be an object.")
        uri = value.get("uri")
        digest = value.get("digest")
        media_type = value.get("media_type")
        size_bytes = value.get("size_bytes")
        if not isinstance(uri, str) or not uri.strip():
            raise ValueError("Artifact reference uri must be non-empty.")
        if not isinstance(digest, str) or _SHA256_DIGEST.fullmatch(digest) is None:
            raise ValueError("Artifact reference digest must be a lowercase SHA-256.")
        if media_type != ARCHIVE_MEDIA_TYPE:
            raise ValueError("Artifact reference media_type is unsupported.")
        if (
            not isinstance(size_bytes, int)
            or isinstance(size_bytes, bool)
            or size_bytes < 0
        ):
            raise ValueError("Artifact reference size_bytes must be non-negative.")
        return cls(
            uri=uri.strip(),
            digest=digest,
            media_type=media_type,
            size_bytes=size_bytes,
        )

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def local_artifact_reference(path: Path) -> ArtifactReference:
    resolved = path.expanduser().resolve()
    digest = hashlib.sha256()
    with resolved.open("rb") as artifact_file:
        while chunk := artifact_file.read(1024 * 1024):
            digest.update(chunk)
    return ArtifactReference(
        uri=resolved.as_uri(),
        digest=f"sha256:{digest.hexdigest()}",
        media_type=ARCHIVE_MEDIA_TYPE,
        size_bytes=resolved.stat().st_size,
    )


def materialize_artifact(
    reference: ArtifactReference,
    destination: Path,
    *,
    maximum_size: int,
    expected_s3_key: str | None = None,
) -> Path:
    """Download one S3 artifact reference into a verified local archive."""
    if reference.size_bytes > maximum_size:
        raise ValueError("Artifact archive exceeds the compressed size limit.")

    parsed = urlparse(reference.uri)
    if parsed.scheme != "s3":
        raise ValueError(f"Unsupported artifact URI scheme: {parsed.scheme}")
    archive_path = download_s3_input_bundle(
        reference.uri,
        destination,
        expected_size=reference.size_bytes,
        maximum_size=maximum_size,
        expected_key=expected_s3_key,
    ).resolve()

    if not archive_path.is_file():
        raise ValueError(f"Artifact archive not found: {archive_path}")
    if archive_path.stat().st_size != reference.size_bytes:
        raise ValueError("Artifact archive size does not match reference.")
    digest = hashlib.sha256()
    with archive_path.open("rb") as archive_file:
        while chunk := archive_file.read(1024 * 1024):
            digest.update(chunk)
    if f"sha256:{digest.hexdigest()}" != reference.digest:
        raise ValueError("Artifact archive digest does not match reference.")
    return archive_path


__all__ = [
    "ARCHIVE_MEDIA_TYPE",
    "ArtifactReference",
    "local_artifact_reference",
    "materialize_artifact",
]
