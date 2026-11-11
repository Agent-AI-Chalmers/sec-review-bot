"""Exercise the Python-to-TypeScript memory boundary against real HTTP and SQL."""

import uuid

import pytest
from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.memory.catalog_client import (
    MemoryCatalogClient,
    MemoryCatalogConflictError,
)


def test_python_catalog_publication_replay_and_conflict(catalog):
    """Response-loss replay must not duplicate extraction or bypass confirmation."""
    client = MemoryCatalogClient(catalog["url"], "seam-worker")
    extraction_id = f"seam-{uuid.uuid4().hex}"
    trajectory = ArtifactReference(
        uri=f"s3://sec-review/memory/{extraction_id}.jsonl.zst",
        digest=f"sha256:{'a' * 64}",
        media_type="application/zstd",
        size_bytes=42,
    )
    registration = {
        "extraction_id": extraction_id,
        "source_workflow": "issue-review",
        "source_run_id": extraction_id,
        "source_unit_id": "review",
        "execution_archive_digest": f"sha256:{'b' * 64}",
        "trajectory_reference": trajectory.as_dict(),
        "observations": [
            {
                "observation_id": f"{extraction_id}:1",
                "body_markdown": "跨语言 observation",
            },
            {"observation_id": f"{extraction_id}:2", "body_markdown": "独立经验"},
        ],
    }
    intent = {"registration": registration, "summary": "Seam probe"}
    arguments = {
        key: value
        for key, value in registration.items()
        if key not in {"trajectory_reference"}
    }
    arguments.update(trajectory_reference=trajectory)
    client.reserve_extraction_publication(intent)
    with pytest.raises(MemoryCatalogConflictError):
        client.register_extraction(**arguments)
    client.confirm_extraction_publication(intent)
    assert client.register_extraction(**arguments) is True
    assert client.register_extraction(**arguments) is False
    assert client.list_extraction_publications(extraction_id) == [
        {"intent": intent, "status": "selected"}
    ]
    stored = client.get_extraction(extraction_id)
    assert stored["extraction_id"] == extraction_id
    assert stored["observations"] == registration["observations"]
    with pytest.raises(MemoryCatalogConflictError):
        client.reserve_extraction_publication({**intent, "summary": "conflicting"})
    with pytest.raises(RuntimeError, match="HTTP 401"):
        MemoryCatalogClient(catalog["url"], "wrong-token").get_extraction(extraction_id)
