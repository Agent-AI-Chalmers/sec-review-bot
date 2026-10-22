"""Publish one local artifact as an immutable S3 object."""

from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import boto3  # type: ignore[import-untyped]
from botocore.config import Config  # type: ignore[import-untyped]
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from sec_review_agents.artifacts.input_storage import (
    ARTIFACT_S3_BUCKET_ENV,
    ARTIFACT_S3_ENDPOINT_ENV,
)
from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.utils.env import env_value


def publish_immutable_s3_artifact(
    reference: ArtifactReference,
    *,
    key: str,
    description: str,
) -> ArtifactReference:
    bucket = env_value(ARTIFACT_S3_BUCKET_ENV)
    if bucket is None:
        raise RuntimeError(
            f"{ARTIFACT_S3_BUCKET_ENV} is required to publish {description}."
        )
    archive_path = Path(unquote(urlparse(reference.uri).path))
    client = boto3.client(
        "s3",
        endpoint_url=env_value(ARTIFACT_S3_ENDPOINT_ENV),
        config=Config(s3={"addressing_style": "path"}),
    )
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


__all__ = ["publish_immutable_s3_artifact"]
