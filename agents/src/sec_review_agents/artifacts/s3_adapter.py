"""Read and publish immutable artifact objects in S3-compatible storage."""

from pathlib import Path
from typing import Any

import boto3  # type: ignore[import-untyped]
from botocore.config import Config  # type: ignore[import-untyped]
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.artifacts.uri import (
    parse_local_artifact_uri,
    parse_s3_artifact_uri,
)
from sec_review_agents.utils.env import env_value

ARTIFACT_S3_BUCKET_ENV = "SEC_REVIEW_ARTIFACT_S3_BUCKET"
ARTIFACT_S3_ENDPOINT_ENV = "SEC_REVIEW_ARTIFACT_S3_ENDPOINT"
ARTIFACT_S3_ADDRESSING_STYLE_ENV = "SEC_REVIEW_ARTIFACT_S3_ADDRESSING_STYLE"


def _s3_addressing_style() -> str:
    style = env_value(ARTIFACT_S3_ADDRESSING_STYLE_ENV) or "auto"
    if style not in {"auto", "path", "virtual"}:
        raise ValueError(
            f"{ARTIFACT_S3_ADDRESSING_STYLE_ENV} must be auto, path, or virtual."
        )
    return style


def _s3_client() -> Any:
    return boto3.client(
        "s3",
        endpoint_url=env_value(ARTIFACT_S3_ENDPOINT_ENV),
        config=Config(s3={"addressing_style": _s3_addressing_style()}),
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
    bucket, key = parse_s3_artifact_uri(uri)
    configured_bucket = env_value(ARTIFACT_S3_BUCKET_ENV)
    if configured_bucket is None:
        raise ValueError(f"{ARTIFACT_S3_BUCKET_ENV} is required for S3 artifacts.")
    if bucket != configured_bucket:
        raise ValueError("Artifact URI uses an unconfigured S3 bucket.")
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


def planned_s3_artifact(reference: ArtifactReference, *, key: str) -> ArtifactReference:
    """Describe an immutable upload before performing any storage write."""
    bucket = env_value(ARTIFACT_S3_BUCKET_ENV)
    if bucket is None:
        raise RuntimeError(f"{ARTIFACT_S3_BUCKET_ENV} is required for publication.")
    return ArtifactReference(
        uri=f"s3://{bucket}/{key}",
        digest=reference.digest,
        media_type=reference.media_type,
        size_bytes=reference.size_bytes,
    )


def s3_artifact_exists(reference: ArtifactReference) -> bool:
    """Return false only for definite absence; preserve storage uncertainty."""
    bucket, key = parse_s3_artifact_uri(reference.uri)
    if bucket != env_value(ARTIFACT_S3_BUCKET_ENV):
        raise ValueError("Artifact URI uses an unconfigured S3 bucket.")
    try:
        head = _s3_client().head_object(Bucket=bucket, Key=key)
    except ClientError as error:
        if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 404:
            return False
        raise
    _assert_existing_object_matches(
        head, reference=reference, description="memory artifact", error=None
    )
    return True


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
    archive_path = parse_local_artifact_uri(reference.uri)
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
    error: ClientError | None,
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
    "ARTIFACT_S3_ADDRESSING_STYLE_ENV",
    "ARTIFACT_S3_BUCKET_ENV",
    "ARTIFACT_S3_ENDPOINT_ENV",
    "download_s3_object",
    "planned_s3_artifact",
    "publish_immutable_s3_artifact",
    "s3_artifact_exists",
]
