"""Resolve shared artifact references to verified local archives."""

import hashlib
from pathlib import Path
from urllib.parse import unquote, urlparse

from sec_review_agents.artifacts.object_storage import download_s3_object
from sec_review_agents.artifacts.reference import ArtifactReference


def materialize_artifact(
    reference: ArtifactReference,
    destination: Path,
    *,
    maximum_size: int,
    expected_s3_key: str | None = None,
) -> Path:
    """Resolve one shared artifact reference to a verified local archive."""
    if reference.size_bytes > maximum_size:
        raise ValueError("Artifact archive exceeds the compressed size limit.")

    parsed = urlparse(reference.uri)
    if parsed.scheme == "file":
        if parsed.netloc or parsed.query or parsed.fragment:
            raise ValueError("Local artifact URI must be an absolute file URI.")
        archive_path = Path(unquote(parsed.path))
        if not archive_path.is_absolute():
            raise ValueError("Local artifact URI path must be absolute.")
        archive_path = archive_path.resolve()
    elif parsed.scheme == "s3":
        archive_path = download_s3_object(
            reference.uri,
            destination,
            expected_size=reference.size_bytes,
            maximum_size=maximum_size,
            expected_key=expected_s3_key,
        ).resolve()
    else:
        raise ValueError(f"Unsupported artifact URI scheme: {parsed.scheme}")

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


__all__ = ["materialize_artifact"]
