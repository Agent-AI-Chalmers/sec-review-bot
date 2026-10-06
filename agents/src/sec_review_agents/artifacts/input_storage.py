from pathlib import Path
from urllib.parse import unquote, urlparse

import boto3  # type: ignore[import-untyped]
from botocore.config import Config  # type: ignore[import-untyped]

from sec_review_agents.utils.env import env_value

ARTIFACT_S3_BUCKET_ENV = "SEC_REVIEW_ARTIFACT_S3_BUCKET"
ARTIFACT_S3_ENDPOINT_ENV = "SEC_REVIEW_ARTIFACT_S3_ENDPOINT"


def download_s3_input_bundle(
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
        raise ValueError(f"{ARTIFACT_S3_BUCKET_ENV} is required for s3 input bundles.")
    if parsed.netloc != configured_bucket:
        raise ValueError(
            "Runner input input_bundle.uri uses an unconfigured S3 bucket."
        )
    key = unquote(parsed.path).lstrip("/")
    if not key or parsed.query or parsed.fragment:
        raise ValueError("Runner input input_bundle.uri must identify one S3 object.")
    if expected_key is not None and key != expected_key:
        raise ValueError("Runner input input_bundle.uri does not belong to this run.")

    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(f"{destination.suffix}.partial")
    partial.unlink(missing_ok=True)
    client = boto3.client(
        "s3",
        endpoint_url=env_value(ARTIFACT_S3_ENDPOINT_ENV),
        config=Config(s3={"addressing_style": "path"}),
    )
    content_length = client.head_object(Bucket=configured_bucket, Key=key).get(
        "ContentLength"
    )
    if content_length != expected_size:
        raise ValueError(
            "Input bundle S3 object size does not match input_bundle.size_bytes."
        )
    if expected_size > maximum_size:
        raise ValueError("Input bundle archive exceeds the compressed size limit.")
    try:
        with partial.open("wb") as output:
            client.download_fileobj(configured_bucket, key, output)
        partial.replace(destination)
    finally:
        partial.unlink(missing_ok=True)
    return destination
