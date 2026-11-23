"""Recover immutable intents before considering another model execution."""

from unittest.mock import Mock

import pytest

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.memory.coordinated_maintenance import (
    prepare_coordinated_memory_learning,
)
from sec_review_agents.workflows.memory.extraction import (
    MemoryExtractionRequest,
    memory_extraction_workflow_id,
    prepare_memory_extraction,
)


def _report(observation_ids: list[str]) -> dict[str, object]:
    return {
        "observation_decisions": [
            {
                "observation_id": extraction_id,
                "action": "skipped",
                "topics": [],
                "reason": "Already covered.",
            }
            for extraction_id in observation_ids
        ],
        "summary": "Maintained memory.",
    }


def reference(character: str) -> dict[str, object]:
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
    diagnostic = ArtifactReference.from_mapping(reference("a"))
    extraction_id = memory_extraction_workflow_id(
        execution_archive_digest=diagnostic.digest, unit_id="review"
    )
    trajectory_reference = reference("b")
    intent = {
        "registration": {
            "extraction_id": extraction_id,
            "source_workflow": "issue-review",
            "source_run_id": "run-1",
            "source_unit_id": "review",
            "execution_archive_digest": diagnostic.digest,
            "trajectory_reference": trajectory_reference,
            "observations": [
                {
                    "observation_id": "observation-1",
                    "body_markdown": "Original observation.",
                },
                {
                    "observation_id": "observation-2",
                    "body_markdown": "Independent lesson.",
                },
            ],
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
        MemoryExtractionRequest(
            "issue-review",
            "run-1",
            "review",
            diagnostic,
            30,
        )
    )
    assert result.observations == [
        {"observation_id": "observation-1", "body_markdown": "Original observation."},
        {"observation_id": "observation-2", "body_markdown": "Independent lesson."},
    ]
    assert result.summary == "Original summary."
    assert result.trajectory_reference.as_dict() == trajectory_reference
    catalog.confirm_extraction_publication.assert_called_once_with(intent)


@pytest.mark.asyncio
@pytest.mark.parametrize("storage_result", [False, RuntimeError("S3 unavailable")])
async def test_selected_maintenance_never_rebuilds_a_missing_or_uncertain_artifact(
    monkeypatch, storage_result
):
    intent = {
        "expected_active_version": 2,
        "memory_tree_reference": reference("a"),
        "source": {
            "kind": "learning",
            "operation_id": "maintain-1",
            "observation_ids": ["extract-1"],
            "trajectory_reference": reference("b"),
            "maintenance_report": _report(["extract-1"]),
        },
    }
    catalog = Mock()
    catalog.list_version_publications.return_value = [
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
        await prepare_coordinated_memory_learning(
            catalog_client=catalog, operation_id="maintain-1", batch_size=10
        )
    catalog.get_learning_input.assert_not_called()
    catalog.reserve_version_publication.assert_not_called()


@pytest.mark.asyncio
async def test_maintenance_recovery_reuses_tree_trajectory_and_observations(
    monkeypatch,
):
    trajectory_reference = reference("b")
    maintenance_report = _report(["extract-1", "extract-2"])
    intent = {
        "expected_active_version": 2,
        "memory_tree_reference": reference("a"),
        "source": {
            "kind": "learning",
            "operation_id": "maintain-1",
            "observation_ids": ["extract-1", "extract-2"],
            "trajectory_reference": trajectory_reference,
            "maintenance_report": maintenance_report,
        },
    }
    catalog = Mock()
    catalog.list_version_publications.return_value = [
        {"status": "reserved", "intent": intent}
    ]
    probe = Mock(return_value=True)
    monkeypatch.setattr(
        "sec_review_agents.memory.coordinated_maintenance.s3_artifact_exists", probe
    )
    result = await prepare_coordinated_memory_learning(
        catalog_client=catalog, operation_id="maintain-1", batch_size=10
    )
    assert result is not None
    assert result.expected_active_version == 2
    assert result.observation_ids == ("extract-1", "extract-2")
    assert result.memory_tree_reference.as_dict() == intent["memory_tree_reference"]
    assert result.trajectory_reference.as_dict() == trajectory_reference
    # The commit body must equal the confirmed intent, so the recovered report
    # has to serialize back to exactly what was reserved.
    assert result.maintenance_report.model_dump(mode="json") == maintenance_report
    assert probe.call_count == 2
    catalog.confirm_version_publication.assert_called_once_with(intent)
    catalog.get_learning_input.assert_not_called()


@pytest.mark.asyncio
async def test_partial_maintenance_upload_does_not_mix_artifacts_from_different_attempts(
    monkeypatch,
):
    first = {
        "expected_active_version": 2,
        "memory_tree_reference": reference("a"),
        "source": {
            "kind": "learning",
            "operation_id": "maintain-1",
            "observation_ids": ["extract-1"],
            "trajectory_reference": reference("b"),
            "maintenance_report": _report(["extract-1"]),
        },
    }
    complete_trajectory_reference = reference("d")
    complete = {
        "expected_active_version": 3,
        "memory_tree_reference": reference("c"),
        "source": {
            "kind": "learning",
            "operation_id": "maintain-1",
            "observation_ids": ["extract-2"],
            "trajectory_reference": complete_trajectory_reference,
            "maintenance_report": _report(["extract-2"]),
        },
    }
    catalog = Mock()
    catalog.list_version_publications.return_value = [
        {"status": "reserved", "intent": first},
        {"status": "reserved", "intent": complete},
    ]
    monkeypatch.setattr(
        "sec_review_agents.memory.coordinated_maintenance.s3_artifact_exists",
        Mock(side_effect=[True, False, True, True]),
    )
    result = await prepare_coordinated_memory_learning(
        catalog_client=catalog, operation_id="maintain-1", batch_size=10
    )
    assert result is not None
    assert result.expected_active_version == 3
    assert result.observation_ids == ("extract-2",)
    assert result.memory_tree_reference.as_dict() == complete["memory_tree_reference"]
    assert result.trajectory_reference.as_dict() == complete_trajectory_reference
    catalog.confirm_version_publication.assert_called_once_with(complete)
    catalog.get_learning_input.assert_not_called()


@pytest.mark.asyncio
async def test_abandoned_publication_never_recovers_or_runs_model(monkeypatch):
    from sec_review_agents.memory.catalog_client import MemoryPublicationAbandonedError

    catalog = Mock()
    catalog.list_version_publications.return_value = [
        {"status": "abandoned", "intent": {}}
    ]
    exists = Mock(
        side_effect=AssertionError("abandoned artifacts must not be recovered")
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.coordinated_maintenance.s3_artifact_exists", exists
    )
    with pytest.raises(MemoryPublicationAbandonedError):
        await prepare_coordinated_memory_learning(
            catalog_client=catalog, operation_id="abandoned-1", batch_size=10
        )
    catalog.get_learning_input.assert_not_called()
    catalog.confirm_version_publication.assert_not_called()
    exists.assert_not_called()
