"""Read and publish immutable artifact objects in S3-compatible storage."""

from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import boto3  # type: ignore[import-untyped]
from botocore.config import Config  # type: ignore[import-untyped]
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.utils.env import env_value

ARTIFACT_S3_BUCKET_ENV = "SEC_REVIEW_ARTIFACT_S3_BUCKET"
ARTIFACT_S3_ENDPOINT_ENV = "SEC_REVIEW_ARTIFACT_S3_ENDPOINT"


def _s3_client() -> Any:
    return boto3.client(
        "s3",
        endpoint_url=env_value(ARTIFACT_S3_ENDPOINT_ENV),
        config=Config(s3={"addressing_style": "path"}),
    )


def download_s3_object(
    uri: str,
    destination: Path,
    *,
    expected_size: int,
    maximum_size: int,
    expected_key: str | None = None,
) -> Path:
    """Download one S3 object completely before archive validation begins."""
    parsed = urlparse(uri)
    configured_bucket = env_value(ARTIFACT_S3_BUCKET_ENV)
    if configured_bucket is None:
        raise ValueError(f"{ARTIFACT_S3_BUCKET_ENV} is required for S3 artifacts.")
    if parsed.netloc != configured_bucket:
        raise ValueError("Artifact URI uses an unconfigured S3 bucket.")
    key = unquote(parsed.path).lstrip("/")
    if not key or parsed.query or parsed.fragment:
        raise ValueError("Artifact URI must identify one S3 object.")
    if expected_key is not None and key != expected_key:
        raise ValueError("Artifact URI does not match the expected object key.")

    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(f"{destination.suffix}.partial")
    partial.unlink(missing_ok=True)
    client = _s3_client()
    content_length = client.head_object(Bucket=configured_bucket, Key=key).get(
        "ContentLength"
    )
    if content_length != expected_size:
        raise ValueError("S3 artifact object size does not match the expected size.")
    if expected_size > maximum_size:
        raise ValueError("Artifact object exceeds the compressed size limit.")
    try:
        with partial.open("wb") as output:
            client.download_fileobj(configured_bucket, key, output)
        partial.replace(destination)
    finally:
        partial.unlink(missing_ok=True)
    return destination


def publish_immutable_s3_artifact(
    reference: ArtifactReference,
    *,
    key: str,
    description: str,
) -> ArtifactReference:
    """Publish one local artifact as an immutable S3 object."""
    bucket = env_value(ARTIFACT_S3_BUCKET_ENV)
    if bucket is None:
        raise RuntimeError(
            f"{ARTIFACT_S3_BUCKET_ENV} is required to publish {description}."
        )
    archive_path = Path(unquote(urlparse(reference.uri).path))
    client = _s3_client()
    try:
        with archive_path.open("rb") as archive_file:
            client.put_object(
                Bucket=bucket,
                Key=key,
                Body=archive_file,
                ContentType=reference.media_type,
                Metadata={
                    "sha256": reference.digest.removeprefix("sha256:"),
                    "size-bytes": str(reference.size_bytes),
                },
                IfNoneMatch="*",
            )
    except ClientError as error:
        if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") != 412:
            raise
        _assert_existing_object_matches(
            client.head_object(Bucket=bucket, Key=key),
            reference=reference,
            description=description,
            error=error,
        )
    return ArtifactReference(
        uri=f"s3://{bucket}/{key}",
        digest=reference.digest,
        media_type=reference.media_type,
        size_bytes=reference.size_bytes,
    )


def _assert_existing_object_matches(
    head: dict[str, Any],
    *,
    reference: ArtifactReference,
    description: str,
    error: ClientError,
) -> None:
    if (
        head.get("Metadata", {}).get("sha256")
        != reference.digest.removeprefix("sha256:")
        or head.get("Metadata", {}).get("size-bytes") != str(reference.size_bytes)
        or head.get("ContentLength") != reference.size_bytes
        or head.get("ContentType") != reference.media_type
    ):
        raise RuntimeError(
            f"Existing {description} differs from immutable publication."
        ) from error


__all__ = [
    "ARTIFACT_S3_BUCKET_ENV",
    "ARTIFACT_S3_ENDPOINT_ENV",
    "download_s3_object",
    "publish_immutable_s3_artifact",
]
