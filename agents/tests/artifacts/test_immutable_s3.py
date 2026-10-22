from pathlib import Path
from unittest.mock import Mock, patch

import pytest
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from sec_review_agents.artifacts.immutable_s3 import publish_immutable_s3_artifact
from sec_review_agents.artifacts.reference import (
    local_artifact_reference,
    materialize_artifact,
)


def test_publish_immutable_s3_artifact_requires_bucket(tmp_path: Path) -> None:
    artifact = tmp_path / "artifact.tar.zst"
    artifact.write_bytes(b"archive")

    with (
        patch.dict("os.environ", {}, clear=True),
        pytest.raises(RuntimeError, match="SEC_REVIEW_ARTIFACT_S3_BUCKET"),
    ):
        publish_immutable_s3_artifact(
            local_artifact_reference(artifact),
            key="memory/test.tar.zst",
            description="test artifact",
        )


def test_publish_immutable_s3_artifact_uploads_and_returns_s3_reference(
    tmp_path: Path,
) -> None:
    artifact = tmp_path / "artifact.tar.zst"
    artifact.write_bytes(b"archive")
    reference = local_artifact_reference(artifact)
    client = Mock()

    with (
        patch.dict(
            "os.environ", {"SEC_REVIEW_ARTIFACT_S3_BUCKET": "artifacts"}, clear=True
        ),
        patch(
            "sec_review_agents.artifacts.immutable_s3.boto3.client", return_value=client
        ),
    ):
        published = publish_immutable_s3_artifact(
            reference,
            key="memory/test.tar.zst",
            description="test artifact",
        )

    assert published.uri == "s3://artifacts/memory/test.tar.zst"
    client.put_object.assert_called_once()
    assert client.put_object.call_args.kwargs["IfNoneMatch"] == "*"


def test_publish_immutable_s3_artifact_reuses_identical_existing_object(
    tmp_path: Path,
) -> None:
    artifact = tmp_path / "artifact.tar.zst"
    artifact.write_bytes(b"archive")
    reference = local_artifact_reference(artifact)
    client = Mock()
    client.put_object.side_effect = ClientError(
        {"ResponseMetadata": {"HTTPStatusCode": 412}}, "PutObject"
    )
    client.head_object.return_value = {
        "Metadata": {
            "sha256": reference.digest.removeprefix("sha256:"),
            "size-bytes": str(reference.size_bytes),
        },
        "ContentLength": reference.size_bytes,
        "ContentType": reference.media_type,
    }

    with (
        patch.dict(
            "os.environ", {"SEC_REVIEW_ARTIFACT_S3_BUCKET": "artifacts"}, clear=True
        ),
        patch(
            "sec_review_agents.artifacts.immutable_s3.boto3.client", return_value=client
        ),
    ):
        published = publish_immutable_s3_artifact(
            reference,
            key="memory/test.tar.zst",
            description="test artifact",
        )

    assert published.uri == "s3://artifacts/memory/test.tar.zst"
    client.head_object.assert_called_once_with(
        Bucket="artifacts", Key="memory/test.tar.zst"
    )


def test_publish_immutable_s3_artifact_rejects_conflicting_existing_object(
    tmp_path: Path,
) -> None:
    artifact = tmp_path / "artifact.tar.zst"
    artifact.write_bytes(b"archive")
    reference = local_artifact_reference(artifact)
    client = Mock()
    client.put_object.side_effect = ClientError(
        {"ResponseMetadata": {"HTTPStatusCode": 412}}, "PutObject"
    )
    client.head_object.return_value = {
        "Metadata": {"sha256": "0" * 64, "size-bytes": "7"},
        "ContentLength": 7,
        "ContentType": reference.media_type,
    }

    with (
        patch.dict(
            "os.environ", {"SEC_REVIEW_ARTIFACT_S3_BUCKET": "artifacts"}, clear=True
        ),
        patch(
            "sec_review_agents.artifacts.immutable_s3.boto3.client", return_value=client
        ),
        pytest.raises(RuntimeError, match="differs from immutable publication"),
    ):
        publish_immutable_s3_artifact(
            reference,
            key="memory/test.tar.zst",
            description="test artifact",
        )


def test_materialize_artifact_rejects_file_references(tmp_path: Path) -> None:
    artifact = tmp_path / "artifact.tar.zst"
    artifact.write_bytes(b"archive")
    reference = local_artifact_reference(artifact)

    with pytest.raises(ValueError, match="Unsupported artifact URI scheme: file"):
        materialize_artifact(reference, tmp_path / "unused", maximum_size=100)
