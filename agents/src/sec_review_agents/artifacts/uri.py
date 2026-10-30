"""Parse and validate artifact URI shapes."""

from pathlib import Path
from urllib.parse import SplitResult, unquote, urlsplit


def parse_artifact_uri(value: object) -> SplitResult:
    """Parse a stable absolute artifact URI without transport-specific parameters."""
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError("Artifact reference uri must be canonical and non-empty.")
    if any(character.isspace() for character in value):
        raise ValueError("Artifact reference uri must not contain whitespace.")
    try:
        parsed = urlsplit(value)
    except ValueError as error:
        raise ValueError("Artifact reference uri is invalid.") from error
    if not parsed.scheme or not (parsed.netloc or parsed.path):
        raise ValueError("Artifact reference uri must be absolute.")
    if parsed.query or parsed.fragment:
        raise ValueError("Artifact reference uri must not contain query or fragment.")
    return parsed


def parse_local_artifact_uri(uri: str) -> Path:
    """Return the absolute local path identified by a file artifact URI."""
    parsed = parse_artifact_uri(uri)
    if (
        parsed.scheme != "file"
        or parsed.netloc not in {"", "localhost"}
        or not parsed.path.startswith("/")
        or parsed.path == "/"
    ):
        raise ValueError("Artifact file uri must be an absolute local file URI.")
    return Path(unquote(parsed.path))


def parse_s3_artifact_uri(uri: str) -> tuple[str, str]:
    """Return the bucket and object key identified by an S3 artifact URI."""
    parsed = parse_artifact_uri(uri)
    if (
        parsed.scheme != "s3"
        or not parsed.netloc
        or "@" in parsed.netloc
        or ":" in parsed.netloc
        or not parsed.path.startswith("/")
        or parsed.path == "/"
    ):
        raise ValueError("Artifact S3 uri must identify a bucket and object key.")
    return parsed.netloc, unquote(parsed.path.removeprefix("/"))


__all__ = [
    "parse_artifact_uri",
    "parse_local_artifact_uri",
    "parse_s3_artifact_uri",
]
