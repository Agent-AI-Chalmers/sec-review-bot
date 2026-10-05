from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from sec_review_agents.artifacts.input_storage import download_s3_input_bundle


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
        "sec_review_agents.artifacts.input_storage.boto3.client", return_value=client
    ):
        result = download_s3_input_bundle(
            "s3://sec-review/runs/run-1/input/input-bundle.v1.tar.zst",
            destination,
            expected_size=7,
            maximum_size=100,
        )

    assert result == destination
    assert destination.read_bytes() == b"archive"
    assert not destination.with_suffix(".zst.partial").exists()


def test_rejects_s3_bucket_outside_runner_configuration(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")

    with pytest.raises(ValueError, match="unconfigured S3 bucket"):
        download_s3_input_bundle(
            "s3://other/runs/run-1/input/input-bundle.v1.tar.zst",
            tmp_path / "input-bundle.tar.zst",
            expected_size=1,
            maximum_size=100,
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
            "sec_review_agents.artifacts.input_storage.boto3.client",
            return_value=client,
        ),
        pytest.raises(RuntimeError, match="download failed"),
    ):
        download_s3_input_bundle(
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
            "sec_review_agents.artifacts.input_storage.boto3.client",
            return_value=client,
        ),
        pytest.raises(ValueError, match="size does not match"),
    ):
        download_s3_input_bundle(
            "s3://sec-review/runs/run-1/input/input-bundle.v1.tar.zst",
            tmp_path / "input-bundle.tar.zst",
            expected_size=7,
            maximum_size=100,
        )

    client.download_fileobj.assert_not_called()
