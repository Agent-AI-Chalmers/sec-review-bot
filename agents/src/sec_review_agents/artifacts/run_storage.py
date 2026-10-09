"""Store immutable, diagnostic-only artifacts for terminal Runner runs."""

import hashlib
import tarfile
import tempfile
from pathlib import Path
from typing import Any

import boto3  # type: ignore[import-untyped]
from botocore.config import Config  # type: ignore[import-untyped]
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from sec_review_agents.utils.env import env_value

STORAGE_BUCKET_ENV = "SEC_REVIEW_ARTIFACT_S3_BUCKET"
STORAGE_ENDPOINT_ENV = "SEC_REVIEW_ARTIFACT_S3_ENDPOINT"
STORAGE_ACCESS_KEY_ENV = "AWS_ACCESS_KEY_ID"
STORAGE_SECRET_KEY_ENV = "AWS_SECRET_ACCESS_KEY"


def store_run_artifacts(root: str | Path, run_id: str) -> dict[str, Any] | None:
    """Freeze and store one run directory without exposing storage to workers."""
    source = Path(root).expanduser().resolve()
    if not source.is_dir():
        return None
    bucket = env_value(STORAGE_BUCKET_ENV)
    access_key = env_value(STORAGE_ACCESS_KEY_ENV)
    secret_key = env_value(STORAGE_SECRET_KEY_ENV)
    if not bucket or not access_key or not secret_key:
        raise RuntimeError("artifact storage configuration is incomplete")

    key = f"runs/{run_id}/artifacts/diagnostic-tree.v1.tar.zst"
    media_type = "application/zstd"
    client = boto3.client(
        "s3",
        endpoint_url=env_value(STORAGE_ENDPOINT_ENV),
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(s3={"addressing_style": "path"}),
    )
    try:
        # Terminal status is read repeatedly. Reuse the immutable publication
        # instead of traversing and compressing the artifact tree on every GET.
        return _reference_from_head(
            bucket, key, media_type, client.head_object(Bucket=bucket, Key=key)
        )
    except ClientError as error:
        if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") != 404:
            raise

    # The source tree is a read-only service mount. Build the archive in the
    # container's writable system temp directory, never beside the source.
    with tempfile.NamedTemporaryFile(suffix=".tar.zst") as archive_file:
        with tarfile.open(fileobj=archive_file, mode="w:zst") as archive:
            # The archive is created from a read-only service mount after the
            # workflow reaches a terminal state; workers never receive storage credentials.
            archive.add(source, arcname="artifact-tree", recursive=True)
        archive_file.flush()
        archive_file.seek(0)
        digest = hashlib.sha256(archive_file.read()).hexdigest()
        size = archive_file.tell()
        archive_file.seek(0)
        try:
            client.put_object(
                Bucket=bucket,
                Key=key,
                Body=archive_file,
                ContentType=media_type,
                Metadata={"sha256": digest, "size-bytes": str(size)},
                IfNoneMatch="*",
            )
        except ClientError as error:
            # A terminal run may be observed more than once; the deterministic
            # key makes a matching existing object an idempotent publication.
            if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") != 412:
                raise
            head = client.head_object(Bucket=bucket, Key=key)
            if _object_identity(head) != (digest, size, media_type):
                raise RuntimeError(
                    "existing diagnostic artifact has different immutable metadata"
                ) from error
    return _artifact_reference(bucket, key, media_type, digest, size)


def _reference_from_head(
    bucket: str, key: str, media_type: str, head: dict[str, Any]
) -> dict[str, Any]:
    digest, size, existing_media_type = _object_identity(head)
    if not digest or size < 0 or existing_media_type != media_type:
        raise RuntimeError("existing diagnostic artifact metadata is invalid")
    return _artifact_reference(bucket, key, media_type, digest, size)


def _object_identity(head: dict[str, Any]) -> tuple[str, int, str | None]:
    metadata = head.get("Metadata", {})
    digest = metadata.get("sha256", "")
    declared_size = metadata.get("size-bytes")
    content_length = head.get("ContentLength")
    try:
        size = int(declared_size)
    except TypeError, ValueError:
        return digest, -1, head.get("ContentType")
    if content_length != size:
        return digest, -1, head.get("ContentType")
    return digest, size, head.get("ContentType")


def _artifact_reference(
    bucket: str, key: str, media_type: str, digest: str, size: int
) -> dict[str, Any]:
    return {
        "kind": "diagnostic_bundle",
        "uri": f"s3://{bucket}/{key}",
        "media_type": media_type,
        "digest": f"sha256:{digest}",
        "size_bytes": size,
    }
