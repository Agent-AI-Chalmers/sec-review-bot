import pytest
import yaml
from jsonschema import Draft202012Validator

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.execution_archives.models import ExecutionArchive
from tests.project_paths import CONTRACTS_ROOT


def _archive(uri: str, *, media_type="application/tar+zstd", size_bytes=42):
    return ExecutionArchive(
        reference=ArtifactReference(
            uri=uri,
            digest=f"sha256:{'a' * 64}",
            media_type=media_type,
            size_bytes=size_bytes,
        ),
        unit_ids=("review",),
    )


@pytest.mark.parametrize(
    ("scheme", "uri"),
    [
        ("s3", "s3://sec-review/runs/run-1/artifacts/execution-archive.v1.tar.zst"),
        ("file", "file:///tmp/run-1/published/execution-archive.v1.tar.zst"),
    ],
)
def test_archive_projects_existing_reference_into_public_contract(scheme, uri):
    archive = _archive(uri)
    storage = archive.to_artifact_storage()
    assert storage == {
        "status": "available",
        "artifact": {
            "kind": "execution_archive",
            "uri": uri,
            "digest": f"sha256:{'a' * 64}",
            "media_type": "application/tar+zstd",
            "size_bytes": 42,
        },
    }
    spec = yaml.safe_load(
        (CONTRACTS_ROOT / "execution-api/v1/openapi.yaml").read_text()
    )
    Draft202012Validator(
        {
            "$ref": "#/components/schemas/ExecutionArtifactStorage",
            "components": spec["components"],
        }
    ).validate(storage)
