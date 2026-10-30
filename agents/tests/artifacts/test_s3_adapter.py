from pathlib import Path
from unittest.mock import Mock, patch

import pytest
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from sec_review_agents.artifacts.reference import local_artifact_reference
from sec_review_agents.artifacts.s3_adapter import (
    download_s3_object,
    publish_immutable_s3_artifact,
)


@pytest.mark.parametrize("style", ["auto", "path", "virtual"])
def test_configures_s3_addressing_style(
    monkeypatch, tmp_path: Path, style: str
) -> None:
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_ADDRESSING_STYLE", style)
    client = Mock()
    client.head_object.return_value = {"ContentLength": 7}
    client.download_fileobj.side_effect = lambda _bucket, _key, output: output.write(
        b"archive"
    )

    with patch(
        "sec_review_agents.artifacts.s3_adapter.boto3.client",
        return_value=client,
    ) as create_client:
        download_s3_object(
            "s3://sec-review/runs/run-1/input/input-bundle.v1.tar.zst",
            tmp_path / "input-bundle.tar.zst",
            expected_size=7,
            maximum_size=100,
        )

    assert create_client.call_args.kwargs["config"].s3["addressing_style"] == style


def test_rejects_invalid_s3_addressing_style(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_ADDRESSING_STYLE", "hostname")

    with pytest.raises(
        ValueError, match="SEC_REVIEW_ARTIFACT_S3_ADDRESSING_STYLE must"
    ):
        download_s3_object(
            "s3://sec-review/runs/run-1/input/input-bundle.v1.tar.zst",
            tmp_path / "input-bundle.tar.zst",
            expected_size=7,
            maximum_size=100,
        )


def test_downloads_configured_s3_object_to_complete_local_file(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")
    client = Mock()
    client.head_object.return_value = {"ContentLength": 7}

    def download_fileobj(bucket, key, output):
        assert bucket == "sec-review"
        assert key == "runs/run-1/input/input-bundle.v1.tar.zst"
        output.write(b"archive")

    client.download_fileobj.side_effect = download_fileobj
    destination = tmp_path / "download" / "input-bundle.tar.zst"
    with patch(
        "sec_review_agents.artifacts.s3_adapter.boto3.client", return_value=client
    ):
        result = download_s3_object(
            "s3://sec-review/runs/run-1/input/input-bundle.v1.tar.zst",
            destination,
            expected_size=7,
            maximum_size=100,
            expected_key="runs/run-1/input/input-bundle.v1.tar.zst",
        )

    assert result == destination
    assert destination.read_bytes() == b"archive"
    assert not destination.with_suffix(".zst.partial").exists()


def test_rejects_s3_bucket_outside_runner_configuration(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")

    with pytest.raises(ValueError, match="unconfigured S3 bucket"):
        download_s3_object(
            "s3://other/runs/run-1/input/input-bundle.v1.tar.zst",
            tmp_path / "input-bundle.tar.zst",
            expected_size=1,
            maximum_size=100,
        )


def test_rejects_s3_object_outside_expected_run(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")

    with pytest.raises(ValueError, match="does not match the expected object key"):
        download_s3_object(
            "s3://sec-review/runs/run-other/input/input-bundle.v1.tar.zst",
            tmp_path / "input-bundle.tar.zst",
            expected_size=1,
            maximum_size=100,
            expected_key="runs/run-1/input/input-bundle.v1.tar.zst",
        )


def test_removes_partial_download_after_failure(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")
    client = Mock()
    client.head_object.return_value = {"ContentLength": 7}

    def fail_download(_bucket, _key, output):
        output.write(b"partial")
        raise RuntimeError("download failed")

    client.download_fileobj.side_effect = fail_download
    destination = tmp_path / "input-bundle.tar.zst"
    with (
        patch(
            "sec_review_agents.artifacts.s3_adapter.boto3.client",
            return_value=client,
        ),
        pytest.raises(RuntimeError, match="download failed"),
    ):
        download_s3_object(
            "s3://sec-review/runs/run-1/input/input-bundle.v1.tar.zst",
            destination,
            expected_size=7,
            maximum_size=100,
        )

    assert not destination.exists()
    assert not destination.with_suffix(".zst.partial").exists()


def test_rejects_remote_size_before_downloading(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")
    client = Mock()
    client.head_object.return_value = {"ContentLength": 200}
    with (
        patch(
            "sec_review_agents.artifacts.s3_adapter.boto3.client",
            return_value=client,
        ),
        pytest.raises(ValueError, match="size does not match"),
    ):
        download_s3_object(
            "s3://sec-review/runs/run-1/input/input-bundle.v1.tar.zst",
            tmp_path / "input-bundle.tar.zst",
            expected_size=7,
            maximum_size=100,
        )

    client.download_fileobj.assert_not_called()


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
            "sec_review_agents.artifacts.s3_adapter.boto3.client",
            return_value=client,
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
            "sec_review_agents.artifacts.s3_adapter.boto3.client",
            return_value=client,
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
            "sec_review_agents.artifacts.s3_adapter.boto3.client",
            return_value=client,
        ),
        pytest.raises(RuntimeError, match="differs from immutable publication"),
    ):
        publish_immutable_s3_artifact(
            reference,
            key="memory/test.tar.zst",
            description="test artifact",
        )
