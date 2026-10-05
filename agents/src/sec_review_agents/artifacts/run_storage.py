"""Publish immutable, diagnostic-only artifacts for terminal Runner runs."""

import hashlib
import tarfile
import tempfile
from pathlib import Path
from typing import Any

import boto3  # type: ignore[import-untyped]
from botocore.config import Config  # type: ignore[import-untyped]
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from sec_review_agents.utils.env import env_value

PUBLISHER_BUCKET_ENV = "SEC_REVIEW_ARTIFACT_S3_BUCKET"
PUBLISHER_ENDPOINT_ENV = "SEC_REVIEW_ARTIFACT_S3_ENDPOINT"
PUBLISHER_ACCESS_KEY_ENV = "AWS_ACCESS_KEY_ID"
PUBLISHER_SECRET_KEY_ENV = "AWS_SECRET_ACCESS_KEY"


def publish_run_artifacts(root: str | Path, run_id: str) -> dict[str, Any] | None:
    """Freeze one run directory and publish it without exposing storage to workers."""
    source = Path(root).expanduser().resolve()
    if not source.is_dir():
        return None
    bucket = env_value(PUBLISHER_BUCKET_ENV)
    access_key = env_value(PUBLISHER_ACCESS_KEY_ENV)
    secret_key = env_value(PUBLISHER_SECRET_KEY_ENV)
    if not bucket or not access_key or not secret_key:
        raise RuntimeError("artifact publisher storage configuration is incomplete")

    key = f"runs/{run_id}/artifacts/diagnostic-tree.v1.tar.zst"
    with tempfile.NamedTemporaryFile(
        suffix=".tar.zst", dir=source.parent
    ) as archive_file:
        with tarfile.open(fileobj=archive_file, mode="w:zst") as archive:
            # The archive is created from a read-only service mount after the
            # workflow reaches a terminal state; workers never receive storage credentials.
            archive.add(source, arcname="artifact-tree", recursive=True)
        archive_file.flush()
        archive_file.seek(0)
        digest = hashlib.sha256(archive_file.read()).hexdigest()
        size = archive_file.tell()
        archive_file.seek(0)
        client = boto3.client(
            "s3",
            endpoint_url=env_value(PUBLISHER_ENDPOINT_ENV),
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            config=Config(s3={"addressing_style": "path"}),
        )
        try:
            client.put_object(
                Bucket=bucket,
                Key=key,
                Body=archive_file,
                ContentType="application/vnd.sec-review.diagnostic.v1+tar+zstd",
                Metadata={"sha256": digest, "size-bytes": str(size)},
                IfNoneMatch="*",
            )
        except ClientError as error:
            # A terminal run may be observed more than once; the deterministic
            # key makes a matching existing object an idempotent publication.
            if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") != 412:
                raise
            head = client.head_object(Bucket=bucket, Key=key)
            if head.get("Metadata", {}).get("sha256") != digest:
                raise RuntimeError(
                    "existing diagnostic artifact has a different digest"
                ) from error
    return {
        "kind": "diagnostic_bundle",
        "uri": f"s3://{bucket}/{key}",
        "media_type": "application/vnd.sec-review.diagnostic.v1+tar+zstd",
        "digest": f"sha256:{digest}",
        "size_bytes": size,
    }
