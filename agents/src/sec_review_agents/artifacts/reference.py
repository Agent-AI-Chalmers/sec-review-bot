"""Immutable artifact references shared by local and S3 flows."""

import hashlib
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

ARCHIVE_MEDIA_TYPE = "application/tar+zstd"
ZSTD_MEDIA_TYPE = "application/zstd"
_SHA256_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


def _validate_artifact_uri(value: object) -> str:
    """Return a supported artifact URI after validating its canonical shape.

    References are absolute local-file URIs or S3 bucket/object URIs. Query and
    fragment components are excluded to keep stored references stable and unambiguous.
    """
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError("Artifact reference uri must be canonical and non-empty.")
    if any(character.isspace() for character in value):
        raise ValueError("Artifact reference uri must not contain whitespace.")
    try:
        parsed = urlsplit(value)
    except ValueError as error:
        raise ValueError("Artifact reference uri is invalid.") from error
    if parsed.query or parsed.fragment:
        raise ValueError("Artifact reference uri must not contain query or fragment.")
    if parsed.scheme == "file":
        if parsed.netloc not in {"", "localhost"} or not parsed.path.startswith("/"):
            raise ValueError("Artifact file uri must be an absolute local file URI.")
        if parsed.path == "/":
            raise ValueError("Artifact file uri must identify a file path.")
    elif parsed.scheme == "s3":
        if (
            not parsed.netloc
            or "@" in parsed.netloc
            or ":" in parsed.netloc
            or not parsed.path.startswith("/")
            or parsed.path == "/"
        ):
            raise ValueError("Artifact S3 uri must identify a bucket and object key.")
    else:
        raise ValueError("Artifact reference uri scheme must be file or s3.")
    return value


@dataclass(frozen=True)
class ArtifactReference:
    uri: str
    digest: str
    media_type: str
    size_bytes: int

    def __post_init__(self) -> None:
        uri = _validate_artifact_uri(self.uri)
        if (
            not isinstance(self.digest, str)
            or _SHA256_DIGEST.fullmatch(self.digest) is None
        ):
            raise ValueError("Artifact reference digest must be a lowercase SHA-256.")
        if not isinstance(self.media_type, str) or not self.media_type.strip():
            raise ValueError("Artifact reference media_type must be non-empty.")
        if (
            not isinstance(self.size_bytes, int)
            or isinstance(self.size_bytes, bool)
            or self.size_bytes < 0
        ):
            raise ValueError("Artifact reference size_bytes must be non-negative.")
        object.__setattr__(self, "uri", uri)
        object.__setattr__(self, "media_type", self.media_type.strip())

    @classmethod
    def from_mapping(cls, value: Any) -> ArtifactReference:
        if not isinstance(value, dict):
            raise ValueError("Artifact reference must be an object.")
        uri = value.get("uri")
        digest = value.get("digest")
        media_type = value.get("media_type")
        size_bytes = value.get("size_bytes")
        if not isinstance(uri, str):
            raise ValueError("Artifact reference uri must be non-empty.")
        if not isinstance(digest, str):
            raise ValueError("Artifact reference digest must be a lowercase SHA-256.")
        if not isinstance(media_type, str):
            raise ValueError("Artifact reference media_type must be non-empty.")
        if not isinstance(size_bytes, int) or isinstance(size_bytes, bool):
            raise ValueError("Artifact reference size_bytes must be non-negative.")
        return cls(
            uri=uri,
            digest=digest,
            media_type=media_type,
            size_bytes=size_bytes,
        )

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def local_artifact_reference(
    path: Path,
    *,
    media_type: str = ARCHIVE_MEDIA_TYPE,
) -> ArtifactReference:
    resolved = path.expanduser().resolve()
    digest = hashlib.sha256()
    with resolved.open("rb") as artifact_file:
        while chunk := artifact_file.read(1024 * 1024):
            digest.update(chunk)
    return ArtifactReference(
        uri=resolved.as_uri(),
        digest=f"sha256:{digest.hexdigest()}",
        media_type=media_type,
        size_bytes=resolved.stat().st_size,
    )


def require_artifact_media_type(
    reference: ArtifactReference,
    expected_media_type: str,
) -> None:
    """Reject an artifact format unsupported by a concrete consumer."""
    if reference.media_type != expected_media_type:
        raise ValueError(
            "Artifact media_type is unsupported: "
            f"expected {expected_media_type!r}, got {reference.media_type!r}."
        )


__all__ = [
    "ARCHIVE_MEDIA_TYPE",
    "ZSTD_MEDIA_TYPE",
    "ArtifactReference",
    "local_artifact_reference",
    "require_artifact_media_type",
]
