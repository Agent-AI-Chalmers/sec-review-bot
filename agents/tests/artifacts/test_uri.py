from pathlib import Path

import pytest

from sec_review_agents.artifacts.uri import (
    ARTIFACT_URI_SCHEMES,
    parse_artifact_uri,
    parse_local_artifact_uri,
    parse_s3_artifact_uri,
)


def test_parse_artifact_uri_returns_standard_components() -> None:
    parsed = parse_artifact_uri(
        "https://artifacts.example/runs/run-1/input-bundle.tar.zst"
    )

    assert parsed.scheme == "https"
    assert parsed.netloc == "artifacts.example"
    assert parsed.path == "/runs/run-1/input-bundle.tar.zst"
    assert ARTIFACT_URI_SCHEMES == frozenset({"file", "s3", "https"})


@pytest.mark.parametrize("scheme", ["ftp", "gs", "oci", "ipfs"])
def test_parse_artifact_uri_rejects_unadopted_scheme(scheme: str) -> None:
    with pytest.raises(ValueError, match="scheme must be one of: file, https, s3"):
        parse_artifact_uri(f"{scheme}://artifacts.example/object")


def test_parse_local_artifact_uri_accepts_absolute_local_path() -> None:
    assert parse_local_artifact_uri("file:///tmp/artifact.tar.zst") == Path(
        "/tmp/artifact.tar.zst"
    )
    assert parse_local_artifact_uri("file://localhost/tmp/artifact.tar.zst") == Path(
        "/tmp/artifact.tar.zst"
    )


@pytest.mark.parametrize(
    "uri",
    [
        "file:relative/artifact.tar.zst",
        "file://remote-host/tmp/artifact.tar.zst",
        "file:///",
        "s3://bucket/artifact.tar.zst",
    ],
)
def test_parse_local_artifact_uri_rejects_nonlocal_shape(uri: str) -> None:
    with pytest.raises(ValueError, match="absolute local file URI"):
        parse_local_artifact_uri(uri)


def test_parse_s3_artifact_uri_returns_bucket_and_decoded_key() -> None:
    assert parse_s3_artifact_uri("s3://bucket/path/artifact%20bundle.tar.zst") == (
        "bucket",
        "path/artifact bundle.tar.zst",
    )


@pytest.mark.parametrize(
    "uri",
    [
        "s3://bucket",
        "s3://user@bucket/key",
        "s3://bucket:9000/key",
        "file:///tmp/artifact.tar.zst",
    ],
)
def test_parse_s3_artifact_uri_rejects_non_object_shape(uri: str) -> None:
    with pytest.raises(ValueError, match="bucket and object key"):
        parse_s3_artifact_uri(uri)
