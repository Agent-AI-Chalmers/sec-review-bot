import os
import secrets
from pathlib import Path

import boto3  # type: ignore[import-untyped]
import pytest
from botocore.config import Config  # type: ignore[import-untyped]

from sec_review_agents.artifacts.input_storage import download_s3_input_bundle


def test_s3_input_download_round_trip(monkeypatch, tmp_path: Path) -> None:
    endpoint = os.getenv("SEC_REVIEW_TEST_S3_ENDPOINT")
    bucket = os.getenv("SEC_REVIEW_TEST_S3_BUCKET")
    if not endpoint or not bucket:
        pytest.skip("S3 integration environment is not configured.")

    key = f"integration-tests/{secrets.token_hex(8)}/input-bundle.tar.zst"
    body = b"s3-integration-input-bundle"
    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        config=Config(s3={"addressing_style": "path"}),
    )
    client.put_object(Bucket=bucket, Key=key, Body=body)
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", bucket)
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_ENDPOINT", endpoint)
    try:
        destination = download_s3_input_bundle(
            f"s3://{bucket}/{key}",
            tmp_path / "input-bundle.tar.zst",
            expected_size=len(body),
            maximum_size=1024,
        )
        assert destination.read_bytes() == body
    finally:
        client.delete_object(Bucket=bucket, Key=key)
