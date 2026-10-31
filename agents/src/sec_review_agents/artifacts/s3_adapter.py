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

    if expected_size > maximum_size or expected_size < 0:
        raise ValueError("Artifact object exceeds the compressed size limit.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(f"{destination.suffix}.partial")
    partial.unlink(missing_ok=True)
    # One GET binds ContentLength and Body to the same object snapshot. A HEAD
    # followed by an independent managed download would reopen a race here.
    response = _s3_client().get_object(Bucket=configured_bucket, Key=key)
    body = response["Body"]
    try:
        if response.get("ContentLength") != expected_size:
            raise ValueError(
                "S3 artifact object size does not match the expected size."
            )
        received = 0
        with partial.open("wb") as output:
            while chunk := body.read(min(64 * 1024, expected_size - received + 1)):
                received += len(chunk)
                if received > expected_size:
                    raise ValueError("S3 artifact object exceeds the expected size.")
                output.write(chunk)
        if received != expected_size:
            raise ValueError(
                "S3 artifact object size does not match the expected size."
            )
        partial.replace(destination)
    finally:
        body.close()
        partial.unlink(missing_ok=True)
    return destination


def read_s3_artifact_reference(*, key: str) -> ArtifactReference | None:
    """Read a publisher's descriptor; exact-prefix listing establishes absence.

    This discovers a reference rather than trusting the object's contents. Callers
    must verify the downloaded bytes and their domain identity before attachment.
    """
    bucket = env_value(ARTIFACT_S3_BUCKET_ENV)
    if bucket is None:
        raise RuntimeError(f"{ARTIFACT_S3_BUCKET_ENV} is required for S3 artifacts.")
    client = _s3_client()
    # HEAD can report 403 for a missing key without bucket-wide ListBucket.
    # Listing the exact prefix works with a narrowly scoped s3:prefix grant.
    listed = client.list_objects_v2(Bucket=bucket, Prefix=key, MaxKeys=1)
    if not any(item["Key"] == key for item in listed.get("Contents", [])):
        return None
    head = client.head_object(Bucket=bucket, Key=key)
    metadata = head.get("Metadata", {})
    reference = ArtifactReference.from_mapping(
        {
            "uri": f"s3://{bucket}/{key}",
            "digest": f"sha256:{metadata.get('sha256', '')}",
            "media_type": head.get("ContentType"),
            "size_bytes": head.get("ContentLength"),
        }
    )
    if metadata.get("size-bytes") != str(reference.size_bytes):
        raise ValueError("S3 artifact size metadata does not match object size.")
    return reference


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
    client = _s3_client()
    try:
        head = client.head_object(Bucket=bucket, Key=key)
    except ClientError as error:
        status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if status in {403, 404}:
            # HEAD cannot distinguish absence from denied access without broad
            # ListBucket. An exact-prefix LIST uses the narrower publisher grant.
            listed = client.list_objects_v2(Bucket=bucket, Prefix=key, MaxKeys=1)
            if not any(item["Key"] == key for item in listed.get("Contents", [])):
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
    """Publish without overwriting an existing key through this protocol.

    Conditional PUT does not prevent out-of-protocol overwrites or deletion.
    Metadata checks support publisher replay; consumers still verify byte hashes.
    """
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
    "read_s3_artifact_reference",
    "s3_artifact_exists",
]
