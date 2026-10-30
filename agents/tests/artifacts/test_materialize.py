from pathlib import Path

import pytest

from sec_review_agents.artifacts.materialize import materialize_artifact
from sec_review_agents.artifacts.reference import (
    ZSTD_MEDIA_TYPE,
    ArtifactReference,
    local_artifact_reference,
    require_artifact_media_type,
)


def test_artifact_reference_accepts_non_archive_media_type(tmp_path: Path) -> None:
    artifact = tmp_path / "trajectory.jsonl.zst"
    artifact.write_bytes(b"compressed trajectory")

    reference = local_artifact_reference(artifact, media_type=ZSTD_MEDIA_TYPE)

    assert reference.media_type == ZSTD_MEDIA_TYPE
    assert ArtifactReference.from_mapping(reference.as_dict()) == reference


def test_concrete_consumer_rejects_unsupported_media_type(tmp_path: Path) -> None:
    artifact = tmp_path / "trajectory.jsonl.zst"
    artifact.write_bytes(b"compressed trajectory")
    reference = local_artifact_reference(artifact, media_type=ZSTD_MEDIA_TYPE)

    with pytest.raises(ValueError, match="expected 'application/tar\\+zstd'"):
        require_artifact_media_type(reference, "application/tar+zstd")


def test_materialize_artifact_accepts_verified_shared_file_reference(
    tmp_path: Path,
) -> None:
    artifact = tmp_path / "artifact.tar.zst"
    artifact.write_bytes(b"archive")
    reference = local_artifact_reference(artifact)

    assert (
        materialize_artifact(reference, tmp_path / "unused", maximum_size=100)
        == artifact.resolve()
    )


def test_materialize_artifact_decodes_shared_file_uri_path(tmp_path: Path) -> None:
    artifact = tmp_path / "sec review" / "artifact.tar.zst"
    artifact.parent.mkdir()
    artifact.write_bytes(b"archive")
    reference = local_artifact_reference(artifact)

    assert "%20" in reference.uri
    assert (
        materialize_artifact(reference, tmp_path / "unused", maximum_size=100)
        == artifact.resolve()
    )


def test_materialize_artifact_decodes_non_ascii_file_uri_path(tmp_path: Path) -> None:
    artifact = tmp_path / "诊断" / "artifact.tar.zst"
    artifact.parent.mkdir()
    artifact.write_bytes(b"archive")
    reference = local_artifact_reference(artifact)

    assert (
        materialize_artifact(reference, tmp_path / "unused", maximum_size=100)
        == artifact.resolve()
    )


@pytest.mark.parametrize(
    ("uri", "message"),
    [
        ("file:relative/artifact.tar.zst", "absolute local file URI"),
        ("file://remote-host/tmp/artifact.tar.zst", "absolute local file URI"),
        ("file:///tmp/artifact.tar.zst?download=1", "query or fragment"),
        ("s3:", "bucket and object key"),
        ("s3://bucket", "bucket and object key"),
        ("s3://bucket/key#fragment", "query or fragment"),
        ("s3://user@bucket/key", "bucket and object key"),
        ("https://artifacts.example/artifact", "scheme must be file or s3"),
    ],
)
def test_artifact_reference_rejects_noncanonical_uri(
    uri: str,
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        ArtifactReference(
            uri=uri,
            digest=f"sha256:{'a' * 64}",
            media_type="application/tar+zstd",
            size_bytes=7,
        )


def test_materialize_artifact_rejects_modified_shared_file(tmp_path: Path) -> None:
    artifact = tmp_path / "artifact.tar.zst"
    artifact.write_bytes(b"archive")
    reference = local_artifact_reference(artifact)
    artifact.write_bytes(b"changed")

    with pytest.raises(ValueError, match="digest does not match"):
        materialize_artifact(reference, tmp_path / "unused", maximum_size=100)
