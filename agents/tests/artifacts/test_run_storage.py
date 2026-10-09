import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from sec_review_agents.artifacts.run_storage import publish_run_artifacts


def test_publish_run_artifacts_builds_immutable_reference(
    tmp_path: Path, monkeypatch
) -> None:
    root = tmp_path / "run"
    root.mkdir()
    (root / "transcript.txt").write_text("diagnostic", encoding="utf-8")
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_ENDPOINT", "http://rustfs.test")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "publisher")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")
    client = MagicMock()
    client.head_object.side_effect = ClientError(
        {"ResponseMetadata": {"HTTPStatusCode": 404}, "Error": {"Code": "NoSuchKey"}},
        "HeadObject",
    )
    with patch(
        "sec_review_agents.artifacts.run_storage.boto3.client", return_value=client
    ):
        reference = publish_run_artifacts(root, "run-1")

    assert reference is not None
    assert (
        reference["uri"]
        == "s3://sec-review/runs/run-1/artifacts/diagnostic-tree.v1.tar.zst"
    )
    request = client.put_object.call_args.kwargs
    assert request["IfNoneMatch"] == "*"
    assert len(request["Metadata"]["sha256"]) == 64
    assert request["Metadata"]["size-bytes"].isdigit()


def test_publish_run_artifacts_uses_writable_system_temp_directory(
    tmp_path: Path, monkeypatch
) -> None:
    """The Runner source tree is mounted read-only in the service container."""
    root = tmp_path / "run"
    root.mkdir()
    (root / "transcript.txt").write_text("diagnostic", encoding="utf-8")
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "publisher")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")
    client = MagicMock()
    client.head_object.side_effect = ClientError(
        {"ResponseMetadata": {"HTTPStatusCode": 404}, "Error": {"Code": "NoSuchKey"}},
        "HeadObject",
    )
    named_temporary_file = tempfile.NamedTemporaryFile

    def create_temp_file(*args, **kwargs):
        assert "dir" not in kwargs
        return named_temporary_file(*args, **kwargs)

    with (
        patch(
            "sec_review_agents.artifacts.run_storage.boto3.client",
            return_value=client,
        ),
        patch(
            "sec_review_agents.artifacts.run_storage.tempfile.NamedTemporaryFile",
            side_effect=create_temp_file,
        ),
    ):
        publish_run_artifacts(root, "run-read-only-source")


def test_publish_run_artifacts_skips_missing_terminal_tree(tmp_path: Path) -> None:
    assert publish_run_artifacts(tmp_path / "missing", "run-missing") is None


def test_publish_run_artifacts_does_not_hide_upload_failure(
    tmp_path: Path, monkeypatch
) -> None:
    root = tmp_path / "run"
    root.mkdir()
    (root / "diagnostic.txt").write_text("failure", encoding="utf-8")
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_ENDPOINT", "http://rustfs.test")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "publisher")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")
    client = MagicMock()
    client.head_object.side_effect = ClientError(
        {"ResponseMetadata": {"HTTPStatusCode": 404}, "Error": {"Code": "NoSuchKey"}},
        "HeadObject",
    )
    client.put_object.side_effect = RuntimeError("storage unavailable")
    with patch(
        "sec_review_agents.artifacts.run_storage.boto3.client", return_value=client
    ):
        try:
            publish_run_artifacts(root, "run-failed")
        except RuntimeError as error:
            assert str(error) == "storage unavailable"
        else:
            raise AssertionError("publication failure must be raised")


def test_publish_run_artifacts_reuses_existing_immutable_object(
    tmp_path: Path, monkeypatch
) -> None:
    root = tmp_path / "run"
    root.mkdir()
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "publisher")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")
    client = MagicMock()
    client.head_object.return_value = {
        "ContentLength": 42,
        "ContentType": "application/zstd",
        "Metadata": {"sha256": "a" * 64, "size-bytes": "42"},
    }
    with patch(
        "sec_review_agents.artifacts.run_storage.boto3.client", return_value=client
    ):
        reference = publish_run_artifacts(root, "run-existing")

    assert reference == {
        "kind": "diagnostic_bundle",
        "uri": "s3://sec-review/runs/run-existing/artifacts/diagnostic-tree.v1.tar.zst",
        "media_type": "application/zstd",
        "digest": f"sha256:{'a' * 64}",
        "size_bytes": 42,
    }
    client.put_object.assert_not_called()
