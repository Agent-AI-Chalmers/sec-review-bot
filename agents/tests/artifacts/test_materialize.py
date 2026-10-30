import hashlib
from pathlib import Path

import pytest

from sec_review_agents.artifacts.materialize import (
    materialize_verified_artifact_file,
)
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


def test_artifact_reference_accepts_https_locator() -> None:
    reference = ArtifactReference(
        uri="https://artifacts.example/runs/run-1/input-bundle.tar.zst",
        digest=f"sha256:{'a' * 64}",
        media_type="application/tar+zstd",
        size_bytes=7,
    )

    assert reference.uri.startswith("https://artifacts.example/")


def test_artifact_reference_rejects_unadopted_locator_scheme() -> None:
    with pytest.raises(ValueError, match="scheme must be one of: file, https, s3"):
        ArtifactReference(
            uri="oci://registry.example/security/review:latest",
            digest=f"sha256:{'a' * 64}",
            media_type="application/tar+zstd",
            size_bytes=7,
        )


def test_concrete_consumer_rejects_unsupported_media_type(tmp_path: Path) -> None:
    artifact = tmp_path / "trajectory.jsonl.zst"
    artifact.write_bytes(b"compressed trajectory")
    reference = local_artifact_reference(artifact, media_type=ZSTD_MEDIA_TYPE)

    with pytest.raises(ValueError, match="expected 'application/tar\\+zstd'"):
        require_artifact_media_type(reference, "application/tar+zstd")


def test_materialize_verified_artifact_file_accepts_shared_file_reference(
    tmp_path: Path,
) -> None:
    artifact = tmp_path / "artifact.tar.zst"
    artifact.write_bytes(b"archive")
    reference = local_artifact_reference(artifact)

    assert (
        materialize_verified_artifact_file(
            reference,
            local_destination=tmp_path / "unused",
            maximum_bytes=100,
        )
        == artifact.resolve()
    )


def test_materialize_verified_artifact_file_downloads_s3_to_local_destination(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    content = b"archive"
    reference = ArtifactReference(
        uri="s3://artifacts/runs/run-1/archive.tar.zst",
        digest=f"sha256:{hashlib.sha256(content).hexdigest()}",
        media_type="application/tar+zstd",
        size_bytes=len(content),
    )
    destination = tmp_path / "downloaded.tar.zst"
    calls: list[tuple[object, ...]] = []

    def download(
        uri: str,
        local_destination: Path,
        *,
        expected_size: int,
        maximum_size: int,
        expected_key: str | None,
    ) -> Path:
        calls.append(
            (
                uri,
                local_destination,
                expected_size,
                maximum_size,
                expected_key,
            )
        )
        local_destination.write_bytes(content)
        return local_destination

    monkeypatch.setattr(
        "sec_review_agents.artifacts.materialize.download_s3_object",
        download,
    )

    assert (
        materialize_verified_artifact_file(
            reference,
            local_destination=destination,
            maximum_bytes=100,
            expected_s3_key="runs/run-1/archive.tar.zst",
        )
        == destination.resolve()
    )
    assert calls == [
        (
            reference.uri,
            destination,
            reference.size_bytes,
            100,
            "runs/run-1/archive.tar.zst",
        )
    ]


def test_materialize_verified_artifact_file_decodes_file_uri_path(
    tmp_path: Path,
) -> None:
    artifact = tmp_path / "sec review" / "artifact.tar.zst"
    artifact.parent.mkdir()
    artifact.write_bytes(b"archive")
    reference = local_artifact_reference(artifact)

    assert "%20" in reference.uri
    assert (
        materialize_verified_artifact_file(
            reference,
            local_destination=tmp_path / "unused",
            maximum_bytes=100,
        )
        == artifact.resolve()
    )


def test_materialize_verified_artifact_file_decodes_non_ascii_file_uri_path(
    tmp_path: Path,
) -> None:
    artifact = tmp_path / "诊断" / "artifact.tar.zst"
    artifact.parent.mkdir()
    artifact.write_bytes(b"archive")
    reference = local_artifact_reference(artifact)

    assert (
        materialize_verified_artifact_file(
            reference,
            local_destination=tmp_path / "unused",
            maximum_bytes=100,
        )
        == artifact.resolve()
    )


@pytest.mark.parametrize(
    ("uri", "message"),
    [
        ("relative/artifact.tar.zst", "must be absolute"),
        ("file:///tmp/artifact.tar.zst?download=1", "query or fragment"),
        ("s3://bucket/key#fragment", "query or fragment"),
        (" https://artifacts.example/artifact", "canonical and non-empty"),
    ],
)
def test_artifact_reference_rejects_unstable_or_relative_uri(
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


def test_materialize_verified_artifact_file_rejects_https_locator(
    tmp_path: Path,
) -> None:
    reference = ArtifactReference(
        uri="https://artifacts.example/runs/run-1/input-bundle.tar.zst",
        digest=f"sha256:{'a' * 64}",
        media_type="application/tar+zstd",
        size_bytes=7,
    )

    with pytest.raises(ValueError, match="Unsupported artifact URI scheme: https"):
        materialize_verified_artifact_file(
            reference,
            local_destination=tmp_path / "unused",
            maximum_bytes=100,
        )


def test_materialize_verified_artifact_file_rejects_modified_file(
    tmp_path: Path,
) -> None:
    artifact = tmp_path / "artifact.tar.zst"
    artifact.write_bytes(b"archive")
    reference = local_artifact_reference(artifact)
    artifact.write_bytes(b"changed")

    with pytest.raises(ValueError, match="digest does not match"):
        materialize_verified_artifact_file(
            reference,
            local_destination=tmp_path / "unused",
            maximum_bytes=100,
        )
