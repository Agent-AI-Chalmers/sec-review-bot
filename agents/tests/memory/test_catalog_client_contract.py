import json
from email.message import Message
from io import BytesIO
from typing import Any
from unittest.mock import patch
from urllib.error import HTTPError

import pytest
import yaml
from jsonschema import Draft202012Validator

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.memory.catalog_client import (
    MemoryCatalogClient,
    MemoryCatalogConflictError,
)
from tests.project_paths import CONTRACTS_ROOT

CONTRACT_PATH = CONTRACTS_ROOT / "memory-catalog-api" / "openapi.yaml"


def _validator(schema_name: str) -> Draft202012Validator:
    document = yaml.safe_load(CONTRACT_PATH.read_text(encoding="utf-8"))
    schemas = json.loads(
        json.dumps(document["components"]["schemas"]).replace(
            "#/components/schemas/", "#/$defs/"
        )
    )
    return Draft202012Validator({"$defs": schemas, "$ref": f"#/$defs/{schema_name}"})


class _RecordingClient(MemoryCatalogClient):
    responses: list[dict[str, Any]]
    requests: list[tuple[str, str, dict[str, Any] | None]]

    def __init__(self, responses: list[dict[str, Any]]) -> None:
        super().__init__(base_url="http://catalog", token="secret")
        object.__setattr__(self, "responses", responses)
        object.__setattr__(self, "requests", [])

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.requests.append((method, path, body))
        return self.responses.pop(0)


def _artifact(
    name: str,
    *,
    media_type: str = "application/tar+zstd",
) -> ArtifactReference:
    return ArtifactReference(
        uri=f"s3://sec-review/{name}",
        digest=f"sha256:{'a' * 64}",
        media_type=media_type,
        size_bytes=42,
    )


def test_client_wire_values_match_memory_catalog_contract() -> None:
    active_version = {
        "revision": 1,
        "artifact_reference": _artifact("memory").as_dict(),
    }
    revision = {
        "revision": 1,
        "artifact_reference": _artifact("memory").as_dict(),
        "maintenance_transcript_reference": _artifact(
            "maintenance-transcript.jsonl.zst",
            media_type="application/zstd",
        ).as_dict(),
        "created_at": "2026-10-23T00:00:00Z",
    }
    batch = {
        "base_revision": 1,
        "active_memory": _artifact("memory").as_dict(),
        "observations": [
            {"observation_id": "observation-1", "body_markdown": "Remember this."}
        ],
    }
    client = _RecordingClient(
        [
            {"ok": True, "created": True},
            {"pending_count": 1, "oldest_pending_created_at": None},
            {"batch": batch},
            {"completed": True},
            active_version,
            revision,
            {"revisions": [revision], "next_before_revision": None},
        ]
    )

    assert client.register_observation(
        observation_id="observation-1",
        source_workflow="issue-review",
        source_run_id="run-1",
        source_review_unit_id="review",
        transcript_digest=f"sha256:{'b' * 64}",
        body_markdown="Remember this.",
        extraction_transcript_reference=_artifact(
            "extraction-transcript.jsonl.zst",
            media_type="application/zstd",
        ),
    )
    assert client.pending_observation_summary()["pending_count"] == 1
    assert client.select_maintenance_batch(limit=10) == batch
    assert client.complete_maintenance(
        base_revision=1,
        observation_ids=["observation-1"],
        memory_version=_artifact("memory-2"),
        maintenance_transcript_reference=_artifact(
            "maintenance-transcript.jsonl.zst",
            media_type="application/zstd",
        ),
    )
    assert client.active_version() == active_version
    assert client.get_revision(1) == revision
    assert client.list_revisions(before_revision=2, limit=10) == {
        "revisions": [revision],
        "next_before_revision": None,
    }

    request_schemas = {
        "/v1/observations": "ObservationRegistration",
        "/v1/maintenance/batches/select": "MaintenanceBatchSelection",
        "/v1/maintenance/complete": "MaintenanceCompletion",
    }
    for _method, path, body in client.requests:
        schema_name = request_schemas.get(path)
        if schema_name is not None:
            _validator(schema_name).validate(body)

    for schema_name, value in (
        ("ObservationRegistrationResult", {"ok": True, "created": True}),
        (
            "PendingObservationSummary",
            {"pending_count": 1, "oldest_pending_created_at": None},
        ),
        ("MaintenanceBatchResult", {"batch": batch}),
        ("MaintenanceCompletionResult", {"completed": True}),
        ("ActiveVersion", active_version),
        ("MemoryRevision", revision),
        (
            "MemoryRevisionList",
            {"revisions": [revision], "next_before_revision": None},
        ),
    ):
        _validator(schema_name).validate(value)


def test_observation_conflict_preserves_non_retryable_catalog_semantics() -> None:
    client = MemoryCatalogClient(base_url="http://catalog", token="secret")
    conflict = HTTPError(
        "http://catalog/v1/observations",
        409,
        "Conflict",
        Message(),
        BytesIO(b'{"error":"different content"}'),
    )

    with (
        patch(
            "sec_review_agents.memory.catalog_client.urlopen",
            side_effect=conflict,
        ),
        pytest.raises(MemoryCatalogConflictError, match="HTTP 409"),
    ):
        client.register_observation(
            observation_id="observation-1",
            source_workflow="issue-review",
            source_run_id="run-1",
            source_review_unit_id="review",
            transcript_digest=f"sha256:{'b' * 64}",
            body_markdown="Different content.",
            extraction_transcript_reference=_artifact(
                "extraction-transcript.jsonl.zst",
                media_type="application/zstd",
            ),
        )
