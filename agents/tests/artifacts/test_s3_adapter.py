import io
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
    client.get_object.return_value = {
        "ContentLength": 7,
        "Body": io.BytesIO(b"archive"),
    }

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
    client.get_object.return_value = {
        "ContentLength": 7,
        "Body": io.BytesIO(b"archive"),
    }
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

    client.get_object.assert_called_once_with(
        Bucket="sec-review", Key="runs/run-1/input/input-bundle.v1.tar.zst"
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
    body = Mock()
    body.read.side_effect = [b"part", RuntimeError("download failed")]
    client.get_object.return_value = {"ContentLength": 7, "Body": body}
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
    body = io.BytesIO(b"unused")
    client.get_object.return_value = {"ContentLength": 200, "Body": body}
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

    assert body.closed


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


@pytest.mark.parametrize("status", [403, 404, 500])
def test_publication_probe_distinguishes_absence_from_uncertainty(monkeypatch, status):
    from sec_review_agents.artifacts.reference import ArtifactReference
    from sec_review_agents.artifacts.s3_adapter import s3_artifact_exists

    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")
    client = Mock()
    client.head_object.side_effect = ClientError(
        {
            "ResponseMetadata": {"HTTPStatusCode": status},
            "Error": {"Code": str(status)},
        },
        "HeadObject",
    )
    monkeypatch.setattr(
        "sec_review_agents.artifacts.s3_adapter._s3_client", lambda: client
    )
    reference = ArtifactReference(
        uri="s3://sec-review/memory/tree",
        digest=f"sha256:{'a' * 64}",
        media_type="application/zstd",
        size_bytes=42,
    )
    client.list_objects_v2.side_effect = ClientError(
        {"ResponseMetadata": {"HTTPStatusCode": 403}, "Error": {"Code": "403"}},
        "ListObjectsV2",
    )
    with pytest.raises(ClientError):
        s3_artifact_exists(reference)
    if status == 500:
        client.list_objects_v2.assert_not_called()


def test_publication_probe_checks_complete_immutable_identity(monkeypatch):
    from sec_review_agents.artifacts.reference import ArtifactReference
    from sec_review_agents.artifacts.s3_adapter import (
        planned_s3_artifact,
        s3_artifact_exists,
    )

    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")
    local = ArtifactReference(
        uri="file:///unused",
        digest=f"sha256:{'a' * 64}",
        media_type="application/zstd",
        size_bytes=42,
    )
    reference = planned_s3_artifact(local, key="memory/tree")
    assert reference.uri == "s3://sec-review/memory/tree"
    client = Mock()
    head = {
        "ContentLength": 42,
        "ContentType": "application/zstd",
        "Metadata": {"sha256": "a" * 64, "size-bytes": "42"},
    }
    client.head_object.return_value = head
    monkeypatch.setattr(
        "sec_review_agents.artifacts.s3_adapter._s3_client", lambda: client
    )
    assert s3_artifact_exists(reference) is True
    head["Metadata"]["sha256"] = "b" * 64
    with pytest.raises(RuntimeError, match="differs"):
        s3_artifact_exists(reference)


@pytest.mark.parametrize("payload", [b"short", b"archive-extra"])
def test_stream_length_is_enforced_and_destination_survives_failure(
    monkeypatch, tmp_path, payload
):
    """A response length header alone cannot authorize unbounded writes."""
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")
    client = Mock()
    body = io.BytesIO(payload)
    client.get_object.return_value = {"ContentLength": 7, "Body": body}
    monkeypatch.setattr(
        "sec_review_agents.artifacts.s3_adapter._s3_client", lambda: client
    )
    destination = tmp_path / "artifact"
    destination.write_bytes(b"previous")
    with pytest.raises(ValueError, match="size"):
        download_s3_object(
            "s3://sec-review/test", destination, expected_size=7, maximum_size=7
        )
    assert destination.read_bytes() == b"previous"
    assert body.closed
    assert not destination.with_suffix(".partial").exists()
    client.head_object.assert_not_called()


def test_size_limit_rejects_before_storage_read(monkeypatch, tmp_path):
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")
    client = Mock()
    monkeypatch.setattr(
        "sec_review_agents.artifacts.s3_adapter._s3_client", lambda: client
    )
    with pytest.raises(ValueError, match="size limit"):
        download_s3_object(
            "s3://sec-review/test",
            tmp_path / "artifact",
            expected_size=8,
            maximum_size=7,
        )
    client.get_object.assert_not_called()


@pytest.mark.parametrize("status", [403, 404])
@pytest.mark.parametrize("exact_match", [False, True])
def test_publication_probe_uses_scoped_listing_after_ambiguous_head(
    monkeypatch, status, exact_match
):
    from sec_review_agents.artifacts.reference import ArtifactReference
    from sec_review_agents.artifacts.s3_adapter import s3_artifact_exists

    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")
    key = "memory/trees/digest/tree.tar.zst"
    reference = ArtifactReference(
        uri=f"s3://sec-review/{key}",
        digest=f"sha256:{'a' * 64}",
        media_type="application/zstd",
        size_bytes=42,
    )
    client = Mock()
    failure = ClientError(
        {
            "ResponseMetadata": {"HTTPStatusCode": status},
            "Error": {"Code": str(status)},
        },
        "HeadObject",
    )
    client.head_object.side_effect = failure
    # A longer key sharing the prefix must not be mistaken for the exact object.
    client.list_objects_v2.return_value = {
        "Contents": [{"Key": key if exact_match else key + ".other"}]
    }
    monkeypatch.setattr(
        "sec_review_agents.artifacts.s3_adapter._s3_client", lambda: client
    )
    if exact_match:
        with pytest.raises(ClientError) as caught:
            s3_artifact_exists(reference)
        assert caught.value is failure
    else:
        assert s3_artifact_exists(reference) is False
    client.list_objects_v2.assert_called_once_with(
        Bucket="sec-review", Prefix=key, MaxKeys=1
    )


@pytest.mark.integration
def test_memory_publication_probe_against_s3(monkeypatch, tmp_path):
    """Run with the deployed memory identity to cover HEAD 403 on absent objects."""
    import os
    import secrets

    import boto3  # type: ignore[import-untyped]
    from botocore.config import Config  # type: ignore[import-untyped]

    from sec_review_agents.artifacts.reference import local_artifact_reference
    from sec_review_agents.artifacts.s3_adapter import (
        planned_s3_artifact,
        s3_artifact_exists,
    )

    endpoint = os.getenv("SEC_REVIEW_TEST_S3_ENDPOINT")
    bucket = os.getenv("SEC_REVIEW_TEST_S3_BUCKET")
    if not endpoint or not bucket:
        pytest.skip("S3 integration environment is not configured.")
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", bucket)
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_ENDPOINT", endpoint)
    local = tmp_path / "tree.tar.zst"
    local.write_bytes(secrets.token_bytes(32))
    source = local_artifact_reference(local, media_type="application/tar+zstd")
    key = f"memory/trees/{source.digest[7:]}/memory-tree.v1.tar.zst"
    reference = planned_s3_artifact(source, key=key)
    cleanup = None
    if admin_key := os.getenv("SEC_REVIEW_TEST_S3_ADMIN_ACCESS_KEY"):
        cleanup = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=admin_key,
            aws_secret_access_key=os.environ["SEC_REVIEW_TEST_S3_ADMIN_SECRET_KEY"],
            config=Config(s3={"addressing_style": "path"}),
        )
    try:
        assert s3_artifact_exists(reference) is False
        assert (
            publish_immutable_s3_artifact(source, key=key, description="memory tree")
            == reference
        )
        assert s3_artifact_exists(reference) is True
    finally:
        if cleanup is not None:
            cleanup.delete_object(Bucket=bucket, Key=key)
