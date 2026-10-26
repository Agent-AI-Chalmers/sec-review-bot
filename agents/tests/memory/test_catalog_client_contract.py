import json
from email.message import Message
from io import BytesIO
from typing import Any
from unittest.mock import patch
from urllib.error import HTTPError

import pytest
import yaml
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.contract_versions import MEMORY_CATALOG_API_VERSION
from sec_review_agents.memory.catalog_client import (
    MemoryCatalogClient,
    MemoryCatalogConflictError,
)
from tests.project_paths import CONTRACTS_ROOT

CONTRACT_PATH = CONTRACTS_ROOT / "memory-catalog-api" / "v1" / "openapi.yaml"
API_ROOT = f"/{MEMORY_CATALOG_API_VERSION}"


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
    memory_tree = {
        "revision": 1,
        "memory_tree_reference": _artifact("memory").as_dict(),
    }
    revision = {
        "revision": 1,
        "predecessor_revision": None,
        "memory_tree_reference": _artifact("memory").as_dict(),
        "source": {
            "kind": "maintenance",
            "maintenance_id": "maintenance-1",
            "extraction_ids": ["extraction-1"],
            "transcript_reference": _artifact(
                "maintenance-transcript.jsonl.zst",
                media_type="application/zstd",
            ).as_dict(),
        },
        "created_at": "2026-10-23T00:00:00Z",
    }
    maintenance_input = {
        "expected_active_revision": 1,
        "active_memory_tree_reference": _artifact("memory").as_dict(),
        "observations": [
            {"extraction_id": "observation-1", "body_markdown": "Remember this."}
        ],
    }
    extraction = {
        "extraction_id": "extraction-1",
        "source_workflow": "issue-review",
        "source_run_id": "run-1",
        "source_unit_id": "review",
        "diagnostic_bundle_digest": f"sha256:{'b' * 64}",
        "transcript_reference": _artifact(
            "extraction-transcript.jsonl.zst",
            media_type="application/zstd",
        ).as_dict(),
        "observation": {"body_markdown": "Remember this."},
        "created_at": "2026-10-23T00:00:00Z",
    }
    extraction_list = {"extractions": [extraction], "next_cursor": "next-page"}
    observation_list = {
        "observations": [
            {
                "extraction_id": "extraction-1",
                "source_run_id": "run-1",
                "source_unit_id": "review",
                "body_markdown": "Remember this.",
                "consumed_revision": 1,
                "created_at": "2026-10-23T00:00:00Z",
            }
        ],
        "next_cursor": None,
    }
    maintenance_control = {
        "state": "enabled",
        "generation": 0,
        "changed_by": {"kind": "service", "id": "memory-catalog"},
        "changed_at": "2026-10-23T00:00:00Z",
    }
    client = _RecordingClient(
        [
            {"ok": True, "created": True},
            extraction,
            extraction_list,
            observation_list,
            {"pending_count": 1, "oldest_pending_created_at": None},
            maintenance_control,
            {"input": maintenance_input},
            {
                "created": True,
                "revision": 2,
                "source": {"kind": "maintenance", "maintenance_id": "maintenance-2"},
            },
            memory_tree,
            revision,
            {"revisions": [revision], "next_before_revision": None},
        ]
    )

    assert client.register_extraction(
        extraction_id="extraction-1",
        source_workflow="issue-review",
        source_run_id="run-1",
        source_unit_id="review",
        diagnostic_bundle_digest=f"sha256:{'b' * 64}",
        transcript_reference=_artifact(
            "extraction-transcript.jsonl.zst",
            media_type="application/zstd",
        ),
        observation_markdown="Remember this.",
    )
    assert client.get_extraction("extraction-1") == extraction
    assert (
        client.list_extractions(
            cursor="page+/=",
            limit=10,
            source_workflow="issue-review",
            source_run_id="run 1",
            has_observation=True,
        )
        == extraction_list
    )
    assert (
        client.list_observations(
            cursor="observations+/=",
            limit=20,
            status="consumed",
            consumed_revision=1,
        )
        == observation_list
    )
    assert client.get_observation_backlog()["pending_count"] == 1
    assert client.get_maintenance_control() == maintenance_control
    assert client.get_maintenance_input(limit=10) == maintenance_input
    assert client.create_memory_tree_revision(
        maintenance_id="maintenance-2",
        expected_active_revision=1,
        extraction_ids=["extraction-1"],
        memory_tree_reference=_artifact("memory-2"),
        maintenance_transcript_reference=_artifact(
            "maintenance-transcript.jsonl.zst",
            media_type="application/zstd",
        ),
    ) == {
        "created": True,
        "revision": 2,
        "source": {"kind": "maintenance", "maintenance_id": "maintenance-2"},
    }
    assert client.get_memory_tree() == memory_tree
    assert client.get_memory_tree_revision(1) == revision
    assert client.list_memory_tree_revisions(before_revision=2, limit=10) == {
        "revisions": [revision],
        "next_before_revision": None,
    }
    assert [(method, path) for method, path, _body in client.requests] == [
        ("POST", f"{API_ROOT}/extractions"),
        ("GET", f"{API_ROOT}/extractions/extraction-1"),
        (
            "GET",
            (
                f"{API_ROOT}/extractions?limit=10&cursor=page%2B%2F%3D"
                "&source_workflow=issue-review&source_run_id=run+1"
                "&has_observation=true"
            ),
        ),
        (
            "GET",
            (
                f"{API_ROOT}/observations?limit=20&cursor=observations%2B%2F%3D"
                "&status=consumed&consumed_revision=1"
            ),
        ),
        ("GET", f"{API_ROOT}/observation-backlog"),
        ("GET", f"{API_ROOT}/maintenance-control"),
        ("GET", f"{API_ROOT}/maintenance-input?limit=10"),
        ("POST", f"{API_ROOT}/memory-tree/revisions"),
        ("GET", f"{API_ROOT}/memory-tree"),
        ("GET", f"{API_ROOT}/memory-tree/revisions/1"),
        (
            "GET",
            f"{API_ROOT}/memory-tree/revisions?limit=10&before_revision=2",
        ),
    ]

    request_schemas = {
        f"{API_ROOT}/extractions": "ExtractionRegistration",
        f"{API_ROOT}/memory-tree/revisions": "MemoryTreeRevisionCreation",
    }
    for _method, path, body in client.requests:
        schema_name = request_schemas.get(path)
        if schema_name is not None:
            _validator(schema_name).validate(body)

    for schema_name, value in (
        ("ExtractionRegistrationResult", {"ok": True, "created": True}),
        ("ExtractionRecord", extraction),
        ("ExtractionList", extraction_list),
        ("ObservationList", observation_list),
        (
            "ObservationBacklog",
            {"pending_count": 1, "oldest_pending_created_at": None},
        ),
        ("MaintenanceControl", maintenance_control),
        ("MaintenanceInputResult", {"input": maintenance_input}),
        (
            "MemoryTreeRevisionCreationResult",
            {
                "created": True,
                "revision": 2,
                "source": {"kind": "maintenance", "maintenance_id": "maintenance-2"},
            },
        ),
        ("MemoryTree", memory_tree),
        ("MemoryTreeRevision", revision),
        (
            "MemoryTreeRevisionList",
            {"revisions": [revision], "next_before_revision": None},
        ),
    ):
        _validator(schema_name).validate(value)


def test_extraction_conflict_preserves_non_retryable_catalog_semantics() -> None:
    client = MemoryCatalogClient(base_url="http://catalog", token="secret")
    conflict = HTTPError(
        f"http://catalog{API_ROOT}/extractions",
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
        client.register_extraction(
            extraction_id="extraction-1",
            source_workflow="issue-review",
            source_run_id="run-1",
            source_unit_id="review",
            diagnostic_bundle_digest=f"sha256:{'b' * 64}",
            transcript_reference=_artifact(
                "extraction-transcript.jsonl.zst",
                media_type="application/zstd",
            ),
            observation_markdown="Different content.",
        )


def test_operator_revision_and_restore_contracts_are_separate() -> None:
    source: dict[str, Any] = {
        "kind": "operator",
        "operation_id": "operation-1",
        "actor": {"kind": "user", "id": "alice"},
    }
    base = {
        "expected_active_revision": 1,
        "memory_tree_reference": _artifact("memory").as_dict(),
        "source": source,
    }
    validator = _validator("MemoryTreeRevisionCreation")

    validator.validate(base)
    with pytest.raises(ValidationError):
        validator.validate(
            {
                **base,
                "source": {**source, "restored_revision": 1},
            }
        )

    restore = {
        "operation_id": "restore-1",
        "expected_active_revision": 2,
        "restored_revision": 1,
        "actor": {"kind": "user", "id": "alice"},
    }
    restore_validator = _validator("MemoryTreeRestoreOperation")
    restore_validator.validate(restore)
    with pytest.raises(ValidationError):
        restore_validator.validate(
            {key: value for key, value in restore.items() if key != "restored_revision"}
        )
