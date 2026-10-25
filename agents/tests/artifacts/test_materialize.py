from dataclasses import replace
from pathlib import Path

import pytest

from sec_review_agents.artifacts.materialize import materialize_artifact
from sec_review_agents.artifacts.reference import local_artifact_reference


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


def test_materialize_artifact_rejects_relative_file_uri(tmp_path: Path) -> None:
    artifact = tmp_path / "artifact.tar.zst"
    artifact.write_bytes(b"archive")
    reference = replace(
        local_artifact_reference(artifact), uri="file:relative/artifact.tar.zst"
    )

    with pytest.raises(ValueError, match="path must be absolute"):
        materialize_artifact(reference, tmp_path / "unused", maximum_size=100)


def test_materialize_artifact_rejects_modified_shared_file(tmp_path: Path) -> None:
    artifact = tmp_path / "artifact.tar.zst"
    artifact.write_bytes(b"archive")
    reference = local_artifact_reference(artifact)
    artifact.write_bytes(b"changed")

    with pytest.raises(ValueError, match="digest does not match"):
        materialize_artifact(reference, tmp_path / "unused", maximum_size=100)
