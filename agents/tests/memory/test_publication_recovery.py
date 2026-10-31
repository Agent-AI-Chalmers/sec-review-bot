"""Recover immutable intents before considering another model execution."""

from unittest.mock import Mock

import pytest

from sec_review_agents.memory.coordinated_maintenance import (
    prepare_coordinated_memory_revision,
)
from sec_review_agents.workflows.memory.extraction import (
    MemoryExtractionRequest,
    memory_extraction_workflow_id,
    prepare_memory_extraction,
)


def reference(character):
    return {
        "uri": f"s3://sec-review/memory/{character}",
        "digest": f"sha256:{character * 64}",
        "media_type": "application/zstd",
        "size_bytes": 42,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["reserved", "present", "selected"])
async def test_extraction_recovers_full_intent_without_rerunning_model(
    monkeypatch, status
):
    diagnostic = reference("a")
    extraction_id = memory_extraction_workflow_id(
        diagnostic_bundle_digest=diagnostic["digest"], unit_id="review"
    )
    intent = {
        "registration": {
            "extraction_id": extraction_id,
            "source_workflow": "issue-review",
            "source_run_id": "run-1",
            "source_unit_id": "review",
            "diagnostic_bundle_digest": diagnostic["digest"],
            "trajectory_reference": reference("b"),
            "observation": {"body_markdown": "Original observation."},
        },
        "summary": "Original summary.",
    }
    catalog = Mock()
    catalog.list_extraction_publications.return_value = [
        {"status": status, "intent": intent}
    ]
    monkeypatch.setattr(
        "sec_review_agents.memory.catalog_client.configured_memory_catalog_client",
        lambda: catalog,
    )
    monkeypatch.setattr(
        "sec_review_agents.artifacts.s3_adapter.s3_artifact_exists", lambda _: True
    )
    result = await prepare_memory_extraction(
        MemoryExtractionRequest("issue-review", "run-1", "review", diagnostic, 30)
    )
    assert result.observation_markdown == "Original observation."
    assert result.summary == "Original summary."
    assert (
        result.trajectory_reference.as_dict()
        == intent["registration"]["trajectory_reference"]
    )
    catalog.confirm_extraction_publication.assert_called_once_with(intent)


@pytest.mark.asyncio
@pytest.mark.parametrize("storage_result", [False, RuntimeError("S3 unavailable")])
async def test_selected_maintenance_never_rebuilds_a_missing_or_uncertain_artifact(
    monkeypatch, storage_result
):
    intent = {
        "expected_active_revision": 2,
        "memory_tree_reference": reference("a"),
        "source": {
            "kind": "maintenance",
            "maintenance_id": "maintain-1",
            "extraction_ids": ["extract-1"],
            "trajectory_reference": reference("b"),
        },
    }
    catalog = Mock()
    catalog.list_revision_publications.return_value = [
        {"status": "selected", "intent": intent}
    ]
    probe = (
        Mock(side_effect=storage_result)
        if isinstance(storage_result, Exception)
        else Mock(return_value=storage_result)
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.coordinated_maintenance.s3_artifact_exists", probe
    )
    with pytest.raises(RuntimeError):
        await prepare_coordinated_memory_revision(
            catalog_client=catalog, maintenance_id="maintain-1", batch_size=10
        )
    catalog.get_maintenance_input.assert_not_called()
    catalog.reserve_revision_publication.assert_not_called()


@pytest.mark.asyncio
async def test_maintenance_recovery_reuses_tree_trajectory_and_observations(
    monkeypatch,
):
    intent = {
        "expected_active_revision": 2,
        "memory_tree_reference": reference("a"),
        "source": {
            "kind": "maintenance",
            "maintenance_id": "maintain-1",
            "extraction_ids": ["extract-1", "extract-2"],
            "trajectory_reference": reference("b"),
        },
    }
    catalog = Mock()
    catalog.list_revision_publications.return_value = [
        {"status": "reserved", "intent": intent}
    ]
    probe = Mock(return_value=True)
    monkeypatch.setattr(
        "sec_review_agents.memory.coordinated_maintenance.s3_artifact_exists", probe
    )
    result = await prepare_coordinated_memory_revision(
        catalog_client=catalog, maintenance_id="maintain-1", batch_size=10
    )
    assert result is not None
    assert result.expected_active_revision == 2
    assert result.extraction_ids == ("extract-1", "extract-2")
    assert result.memory_tree_reference.as_dict() == intent["memory_tree_reference"]
    assert (
        result.maintenance_trajectory_reference.as_dict()
        == intent["source"]["trajectory_reference"]
    )
    assert probe.call_count == 2
    catalog.confirm_revision_publication.assert_called_once_with(intent)
    catalog.get_maintenance_input.assert_not_called()


@pytest.mark.asyncio
async def test_partial_maintenance_upload_does_not_mix_artifacts_from_different_attempts(
    monkeypatch,
):
    first = {
        "expected_active_revision": 2,
        "memory_tree_reference": reference("a"),
        "source": {
            "kind": "maintenance",
            "maintenance_id": "maintain-1",
            "extraction_ids": ["extract-1"],
            "trajectory_reference": reference("b"),
        },
    }
    complete = {
        "expected_active_revision": 3,
        "memory_tree_reference": reference("c"),
        "source": {
            "kind": "maintenance",
            "maintenance_id": "maintain-1",
            "extraction_ids": ["extract-2"],
            "trajectory_reference": reference("d"),
        },
    }
    catalog = Mock()
    catalog.list_revision_publications.return_value = [
        {"status": "reserved", "intent": first},
        {"status": "reserved", "intent": complete},
    ]
    monkeypatch.setattr(
        "sec_review_agents.memory.coordinated_maintenance.s3_artifact_exists",
        Mock(side_effect=[True, False, True, True]),
    )
    result = await prepare_coordinated_memory_revision(
        catalog_client=catalog, maintenance_id="maintain-1", batch_size=10
    )
    assert result is not None
    assert result.expected_active_revision == 3
    assert result.extraction_ids == ("extract-2",)
    assert result.memory_tree_reference.as_dict() == complete["memory_tree_reference"]
    assert (
        result.maintenance_trajectory_reference.as_dict()
        == complete["source"]["trajectory_reference"]
    )
    catalog.confirm_revision_publication.assert_called_once_with(complete)
    catalog.get_maintenance_input.assert_not_called()
