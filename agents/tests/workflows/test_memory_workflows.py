from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest
from temporalio import activity
from temporalio.converter import DataConverter
from temporalio.worker import Worker

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.memory.revision_creation import MemoryTreeRevisionCreation
from sec_review_agents.workflows.memory import (
    extraction as extraction_workflow,
)
from sec_review_agents.workflows.memory import (
    maintenance as maintenance_workflow,
)
from sec_review_agents.workflows.memory.extraction import (
    MemoryExtractionPreparationResult,
    MemoryExtractionRegistrationPayload,
    MemoryExtractionRequest,
    MemoryExtractionWorkflow,
    memory_extraction_workflow_id,
    prepare_memory_extraction,
)
from sec_review_agents.workflows.memory.maintenance import (
    MemoryMaintenancePreparationResult,
    MemoryMaintenanceRequest,
    MemoryMaintenanceWorkflow,
)
from tests.temporal_test_utils import temporal_time_skipping_environment


def _reference() -> ArtifactReference:
    return ArtifactReference(
        uri="s3://sec-review/runs/run-1/artifacts/diagnostic-tree.v1.tar.zst",
        digest=f"sha256:{'a' * 64}",
        media_type="application/tar+zstd",
        size_bytes=42,
    )


def _revision_creation(
    *, extraction_ids: tuple[str, ...] = ("extraction-1",)
) -> MemoryTreeRevisionCreation:
    return MemoryTreeRevisionCreation(
        maintenance_id="maintenance-run-1",
        base_revision=3,
        extraction_ids=extraction_ids,
        memory_tree_reference=_reference(),
        maintenance_transcript_reference=_reference(),
    )


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"maintenance_id": ""}, "maintenance_id"),
        ({"base_revision": True}, "base_revision"),
        ({"base_revision": -1}, "base_revision"),
        ({"extraction_ids": ()}, "extraction_ids"),
        ({"extraction_ids": ("extraction-1", "extraction-1")}, "unique"),
    ],
)
def test_memory_tree_revision_creation_rejects_invalid_invariants(
    overrides: dict[str, object],
    message: str,
) -> None:
    values: dict[str, object] = {
        "maintenance_id": "maintenance-run-1",
        "base_revision": 3,
        "extraction_ids": ("extraction-1",),
        "memory_tree_reference": _reference(),
        "maintenance_transcript_reference": _reference(),
    }
    values.update(overrides)

    with pytest.raises((TypeError, ValueError), match=message):
        MemoryTreeRevisionCreation(**values)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("reason", "summary"),
    [
        ("Processing disabled.", None),
        (None, "No observations selected."),
    ],
)
def test_complete_maintenance_preparation_accepts_exactly_one_message(
    reason: str | None,
    summary: str | None,
) -> None:
    result = MemoryMaintenancePreparationResult(
        kind="complete",
        reason=reason,
        summary=summary,
    )
    assert result.reason == reason
    assert result.summary == summary


@pytest.mark.parametrize(
    ("reason", "summary"),
    [
        (None, None),
        ("", None),
        (None, "   "),
        ("   ", "No observations selected."),
        ("Processing disabled.", "No observations selected."),
        ("Processing disabled.", "   "),
    ],
)
def test_complete_maintenance_preparation_rejects_invalid_message_shape(
    reason: str | None,
    summary: str | None,
) -> None:
    with pytest.raises(ValueError, match="exactly one non-empty"):
        MemoryMaintenancePreparationResult(
            kind="complete",
            reason=reason,
            summary=summary,
        )


def test_maintenance_preparation_result_rejects_mixed_variants() -> None:
    with pytest.raises(ValueError, match="exactly one non-empty"):
        MemoryMaintenancePreparationResult(
            kind="complete",
            revision_creation=_revision_creation(),
            summary="Already complete.",
        )

    with pytest.raises(ValueError, match="only a revision creation"):
        MemoryMaintenancePreparationResult(
            kind="prepared",
            revision_creation=_revision_creation(),
            reason="Unexpected reason.",
        )


def test_extraction_workflow_id_is_stable_per_transcript_unit() -> None:
    first = memory_extraction_workflow_id(
        diagnostic_bundle_digest=_reference().digest,
        review_unit_id="case-a",
    )
    assert first == memory_extraction_workflow_id(
        diagnostic_bundle_digest=_reference().digest,
        review_unit_id="case-a",
    )
    assert first != memory_extraction_workflow_id(
        diagnostic_bundle_digest=_reference().digest,
        review_unit_id="case-b",
    )


@pytest.mark.asyncio
async def test_extraction_workflow_prepares_then_registers_fixed_payload(
    monkeypatch,
) -> None:
    request = MemoryExtractionRequest(
        source_workflow="issue-review",
        run_id="run-1",
        review_unit_id="review",
        diagnostic_bundle=_reference().as_dict(),
        timeout_seconds=30,
    )
    payload = MemoryExtractionRegistrationPayload(
        extraction_id="extraction-1",
        source_workflow="issue-review",
        source_run_id="run-1",
        source_review_unit_id="review",
        diagnostic_bundle_digest=_reference().digest,
        transcript_reference=_reference(),
        observation_markdown="Remember this.",
        skipped=False,
        summary="Produced observation.",
        observation_produced=True,
    )
    prepared = MemoryExtractionPreparationResult(
        kind="prepared", registration_payload=payload
    )
    result = {"ok": True}
    execute = AsyncMock(side_effect=[prepared, result])
    monkeypatch.setattr(extraction_workflow.workflow, "execute_activity", execute)

    assert await MemoryExtractionWorkflow().run(request) == result
    assert execute.call_args_list[0].args == (
        extraction_workflow.prepare_memory_extraction_activity,
        request,
    )
    assert execute.call_args_list[1].args == (
        extraction_workflow.register_memory_extraction_activity,
        payload,
    )


@pytest.mark.asyncio
async def test_prepare_extraction_returns_complete_serializable_payload(
    monkeypatch,
    tmp_path: Path,
) -> None:
    transcript = tmp_path / "transcript.jsonl"
    transcript.write_text("{}\n", encoding="utf-8")
    preview = SimpleNamespace(
        extraction_id="observation-1",
        observation_markdown="Remember this.",
        skipped=False,
        summary="Produced observation.",
        extractor_transcript_path=tmp_path / "memory-extractor.jsonl",
    )
    extraction_transcript = ArtifactReference(
        uri="s3://sec-review/memory/transcripts/memory-extractor/transcript.v1.jsonl.zst",
        digest=f"sha256:{'b' * 64}",
        media_type="application/zstd",
        size_bytes=10,
    )

    monkeypatch.setattr(
        "sec_review_agents.run_diagnostics.bundle.materialize_diagnostic_transcript_unit",
        lambda *_args, **_kwargs: SimpleNamespace(transcript_paths=(transcript,)),
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.extractor.preview_memory_observation_from_paths",
        AsyncMock(return_value=preview),
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.transcript_artifact.publish_memory_agent_transcript",
        lambda **_kwargs: extraction_transcript,
    )
    request = MemoryExtractionRequest(
        source_workflow="issue-review",
        run_id="run-1",
        review_unit_id="review",
        diagnostic_bundle=_reference().as_dict(),
        timeout_seconds=30,
    )

    result = await prepare_memory_extraction(request)

    assert result == MemoryExtractionRegistrationPayload(
        extraction_id=memory_extraction_workflow_id(
            diagnostic_bundle_digest=_reference().digest,
            review_unit_id="review",
        ),
        source_workflow="issue-review",
        source_run_id="run-1",
        source_review_unit_id="review",
        diagnostic_bundle_digest=_reference().digest,
        transcript_reference=extraction_transcript,
        observation_markdown="Remember this.",
        skipped=False,
        summary="Produced observation.",
        observation_produced=True,
    )


@pytest.mark.asyncio
async def test_extraction_payload_round_trips_through_temporal_converter() -> None:
    payload = MemoryExtractionRegistrationPayload(
        extraction_id="extraction-1",
        source_workflow="issue-review",
        source_run_id="run-1",
        source_review_unit_id="review",
        diagnostic_bundle_digest=_reference().digest,
        transcript_reference=_reference(),
        observation_markdown=None,
        skipped=True,
        summary="No durable memory observation produced.",
        observation_produced=False,
    )

    encoded = await DataConverter.default.encode([payload])
    decoded = await DataConverter.default.decode(
        encoded, [MemoryExtractionRegistrationPayload]
    )

    assert decoded == [payload]


@pytest.mark.asyncio
async def test_extraction_payload_rejects_wrong_field_type_during_conversion() -> None:
    encoded = await DataConverter.default.encode(
        [
            {
                "extraction_id": "extraction-1",
                "source_workflow": "issue-review",
                "source_run_id": "run-1",
                "source_review_unit_id": "review",
                "diagnostic_bundle_digest": _reference().digest,
                "transcript_reference": _reference().as_dict(),
                "observation_markdown": None,
                "skipped": "yes",
                "summary": "No durable memory observation produced.",
                "observation_produced": False,
            }
        ]
    )

    with pytest.raises((TypeError, ValueError), match="skipped"):
        await DataConverter.default.decode(
            encoded, [MemoryExtractionRegistrationPayload]
        )


@pytest.mark.asyncio
async def test_extraction_payload_rejects_inconsistent_observation_flags() -> None:
    encoded = await DataConverter.default.encode(
        [
            {
                "extraction_id": "extraction-1",
                "source_workflow": "issue-review",
                "source_run_id": "run-1",
                "source_review_unit_id": "review",
                "diagnostic_bundle_digest": _reference().digest,
                "transcript_reference": _reference().as_dict(),
                "observation_markdown": "Remember this.",
                "skipped": True,
                "summary": "Produced observation.",
                "observation_produced": False,
            }
        ]
    )

    with pytest.raises(ValueError, match="observation_produced"):
        await DataConverter.default.decode(
            encoded, [MemoryExtractionRegistrationPayload]
        )


def test_extraction_preparation_rejects_empty_disabled_reason() -> None:
    with pytest.raises(ValueError, match="requires only a reason"):
        MemoryExtractionPreparationResult(kind="disabled", reason="")


def test_register_extraction_retries_with_identical_payload_and_no_observation(
    monkeypatch,
) -> None:
    client = Mock()
    transcript_reference = ArtifactReference(
        uri="s3://sec-review/memory/transcripts/memory-extractor/transcript.v1.jsonl.zst",
        digest=f"sha256:{'b' * 64}",
        media_type="application/zstd",
        size_bytes=10,
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.catalog_client.configured_memory_catalog_client",
        lambda: client,
    )
    payload = MemoryExtractionRegistrationPayload(
        extraction_id="extraction-1",
        source_workflow="issue-review",
        source_run_id="run-1",
        source_review_unit_id="review",
        diagnostic_bundle_digest=_reference().digest,
        transcript_reference=transcript_reference,
        observation_markdown=None,
        skipped=True,
        summary="No durable memory observation produced.",
        observation_produced=False,
    )
    monkeypatch.setenv("AGENT_MEMORY_PROCESSING_ENABLED", "false")

    first = extraction_workflow.register_memory_extraction_activity(payload)
    second = extraction_workflow.register_memory_extraction_activity(payload)

    assert (
        first
        == second
        == {
            "ok": True,
            "skipped": True,
            "summary": "No durable memory observation produced.",
            "extraction_id": "extraction-1",
            "observation_produced": False,
            "transcript_reference": transcript_reference.as_dict(),
        }
    )
    expected = {
        "extraction_id": "extraction-1",
        "source_workflow": "issue-review",
        "source_run_id": "run-1",
        "source_review_unit_id": "review",
        "diagnostic_bundle_digest": _reference().digest,
        "transcript_reference": transcript_reference,
        "observation_markdown": None,
    }
    assert client.register_extraction.call_count == 2
    assert client.register_extraction.call_args_list[0].kwargs == expected
    assert client.register_extraction.call_args_list[1].kwargs == expected


@pytest.mark.asyncio
async def test_extraction_workflow_retries_registration_with_history_payload() -> None:
    prepared_payload = MemoryExtractionRegistrationPayload(
        extraction_id="extraction-1",
        source_workflow="issue-review",
        source_run_id="run-1",
        source_review_unit_id="review",
        diagnostic_bundle_digest=_reference().digest,
        transcript_reference=_reference(),
        observation_markdown=None,
        skipped=True,
        summary="No durable memory observation produced.",
        observation_produced=False,
    )
    prepare_calls = 0
    registration_payloads: list[MemoryExtractionRegistrationPayload] = []

    @activity.defn(name="prepare_memory_extraction_activity")
    async def fake_prepare(
        _request: MemoryExtractionRequest,
    ) -> MemoryExtractionPreparationResult:
        nonlocal prepare_calls
        prepare_calls += 1
        return MemoryExtractionPreparationResult(
            kind="prepared", registration_payload=prepared_payload
        )

    @activity.defn(name="register_memory_extraction_activity")
    def fake_register(
        payload: MemoryExtractionRegistrationPayload,
    ) -> dict[str, object]:
        registration_payloads.append(payload)
        if len(registration_payloads) == 1:
            raise RuntimeError("response lost after catalog persistence")
        return {
            "ok": True,
            "skipped": True,
            "summary": "No durable memory observation produced.",
            "extraction_id": "extraction-1",
            "observation_produced": False,
            "transcript_reference": payload.transcript_reference.as_dict(),
        }

    request = MemoryExtractionRequest(
        source_workflow="issue-review",
        run_id="run-1",
        review_unit_id="review",
        diagnostic_bundle=_reference().as_dict(),
        timeout_seconds=30,
    )
    async with temporal_time_skipping_environment() as env:
        with ThreadPoolExecutor(max_workers=2) as executor:
            async with Worker(
                env.client,
                task_queue="memory-extraction-retry-test",
                workflows=[MemoryExtractionWorkflow],
                activities=[fake_prepare, fake_register],
                activity_executor=executor,
            ):
                result = await env.client.execute_workflow(
                    MemoryExtractionWorkflow.run,
                    request,
                    id="memory-extraction-retry-test",
                    task_queue="memory-extraction-retry-test",
                )

    assert result["ok"] is True
    assert prepare_calls == 1
    assert registration_payloads == [prepared_payload, prepared_payload]


def test_catalog_extraction_conflict_is_not_retried(monkeypatch) -> None:
    from temporalio.exceptions import ApplicationError

    from sec_review_agents.memory.catalog_client import MemoryCatalogConflictError

    client = Mock()
    client.register_extraction.side_effect = MemoryCatalogConflictError(
        "extraction content differs"
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.catalog_client.configured_memory_catalog_client",
        Mock(return_value=client),
    )
    payload = MemoryExtractionRegistrationPayload(
        extraction_id="extraction-1",
        source_workflow="issue-review",
        source_run_id="run-1",
        source_review_unit_id="review",
        diagnostic_bundle_digest=_reference().digest,
        transcript_reference=_reference(),
        observation_markdown=None,
        skipped=True,
        summary="No observation.",
        observation_produced=False,
    )

    with pytest.raises(ApplicationError) as captured:
        extraction_workflow.register_memory_extraction_activity(payload)

    assert captured.value.type == "MEMORY_CATALOG_EXTRACTION_CONFLICT"
    assert captured.value.non_retryable is True


@pytest.mark.asyncio
async def test_extraction_activity_requires_catalog_when_processing_is_enabled(
    monkeypatch,
) -> None:
    request = MemoryExtractionRequest(
        source_workflow="issue-review",
        run_id="run-1",
        review_unit_id="review",
        diagnostic_bundle=_reference().as_dict(),
        timeout_seconds=30,
    )
    monkeypatch.setenv("AGENT_MEMORY_PROCESSING_ENABLED", "true")
    monkeypatch.delenv("AGENT_MEMORY_CATALOG_URL", raising=False)

    with pytest.raises(ValueError, match="AGENT_MEMORY_CATALOG_URL"):
        await extraction_workflow.prepare_memory_extraction_activity(request)


@pytest.mark.asyncio
async def test_extraction_activity_skips_when_processing_is_disabled(
    monkeypatch,
) -> None:
    request = MemoryExtractionRequest(
        source_workflow="issue-review",
        run_id="run-1",
        review_unit_id="review",
        diagnostic_bundle=_reference().as_dict(),
        timeout_seconds=30,
    )
    prepare_extraction = AsyncMock()
    monkeypatch.setattr(
        extraction_workflow, "prepare_memory_extraction", prepare_extraction
    )
    monkeypatch.setenv("AGENT_MEMORY_PROCESSING_ENABLED", "false")

    assert await extraction_workflow.prepare_memory_extraction_activity(
        request
    ) == MemoryExtractionPreparationResult(
        kind="disabled",
        reason="AGENT_MEMORY_PROCESSING_ENABLED is false.",
    )
    prepare_extraction.assert_not_awaited()


@pytest.mark.asyncio
async def test_maintenance_prepare_requires_catalog_when_processing_is_enabled(
    monkeypatch,
) -> None:
    monkeypatch.setenv("AGENT_MEMORY_PROCESSING_ENABLED", "true")
    monkeypatch.delenv("AGENT_MEMORY_CATALOG_URL", raising=False)

    with pytest.raises(ValueError, match="AGENT_MEMORY_CATALOG_URL"):
        await maintenance_workflow.prepare_memory_maintenance_activity(
            MemoryMaintenanceRequest(timeout_seconds=30)
        )


@pytest.mark.asyncio
async def test_maintenance_prepare_skips_without_accessing_catalog_when_disabled(
    monkeypatch,
) -> None:
    catalog = Mock()
    prepare = AsyncMock()
    monkeypatch.setenv("AGENT_MEMORY_PROCESSING_ENABLED", "false")
    monkeypatch.setattr(
        "sec_review_agents.memory.catalog_client.configured_memory_catalog_client",
        catalog,
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.coordinated_maintenance.prepare_coordinated_memory_revision",
        prepare,
    )

    result = await maintenance_workflow.prepare_memory_maintenance_activity(
        MemoryMaintenanceRequest(timeout_seconds=30)
    )

    assert result == MemoryMaintenancePreparationResult(
        kind="complete",
        reason="AGENT_MEMORY_PROCESSING_ENABLED is false.",
    )
    catalog.assert_not_called()
    prepare.assert_not_awaited()


@pytest.mark.asyncio
async def test_maintenance_prepare_uses_catalog_input(monkeypatch) -> None:
    client = Mock()
    revision = _revision_creation()
    prepare = AsyncMock(return_value=revision)
    monkeypatch.setattr(
        "sec_review_agents.memory.catalog_client.configured_memory_catalog_client",
        Mock(return_value=client),
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.coordinated_maintenance.prepare_coordinated_memory_revision",
        prepare,
    )
    monkeypatch.setattr(
        maintenance_workflow.activity,
        "info",
        lambda: SimpleNamespace(workflow_run_id="run-1"),
    )

    result = await maintenance_workflow.prepare_memory_maintenance_activity(
        MemoryMaintenanceRequest(timeout_seconds=30, batch_size=7)
    )

    assert result == MemoryMaintenancePreparationResult(
        kind="prepared",
        revision_creation=revision,
    )
    prepare.assert_awaited_once_with(
        catalog_client=client,
        maintenance_id="maintenance-run-1",
        deployment=None,
        batch_size=7,
    )


@pytest.mark.asyncio
async def test_maintenance_prepare_completes_when_catalog_backlog_is_empty(
    monkeypatch,
) -> None:
    client = Mock()
    prepare = AsyncMock(return_value=None)
    monkeypatch.setattr(
        "sec_review_agents.memory.catalog_client.configured_memory_catalog_client",
        Mock(return_value=client),
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.coordinated_maintenance.prepare_coordinated_memory_revision",
        prepare,
    )
    monkeypatch.setattr(
        maintenance_workflow.activity,
        "info",
        lambda: SimpleNamespace(workflow_run_id="run-1"),
    )

    result = await maintenance_workflow.prepare_memory_maintenance_activity(
        MemoryMaintenanceRequest(timeout_seconds=30, batch_size=7)
    )

    assert result == MemoryMaintenancePreparationResult(
        kind="complete",
        summary="No pending memory observations selected.",
    )
    prepare.assert_awaited_once_with(
        catalog_client=client,
        maintenance_id="maintenance-run-1",
        deployment=None,
        batch_size=7,
    )


def test_pending_observation_count_requires_catalog_when_processing_is_enabled(
    monkeypatch,
) -> None:
    monkeypatch.setenv("AGENT_MEMORY_PROCESSING_ENABLED", "true")
    monkeypatch.delenv("AGENT_MEMORY_CATALOG_URL", raising=False)

    with pytest.raises(ValueError, match="AGENT_MEMORY_CATALOG_URL"):
        maintenance_workflow.count_pending_memory_observations_activity()


def test_pending_observation_count_skips_without_accessing_catalog_when_disabled(
    monkeypatch,
) -> None:
    catalog = Mock()
    monkeypatch.setenv("AGENT_MEMORY_PROCESSING_ENABLED", "false")
    monkeypatch.setattr(
        "sec_review_agents.memory.catalog_client.configured_memory_catalog_client",
        catalog,
    )

    assert maintenance_workflow.count_pending_memory_observations_activity() == {
        "ok": True,
        "skipped": True,
        "reason": "AGENT_MEMORY_PROCESSING_ENABLED is false.",
        "pending_count": 0,
        "oldest_pending_created_at": None,
    }
    catalog.assert_not_called()


def test_pending_observation_count_uses_catalog(monkeypatch) -> None:
    client = Mock()
    client.get_observation_backlog.return_value = {
        "pending_count": 2,
        "oldest_pending_created_at": "2026-01-01T00:00:00+00:00",
    }
    monkeypatch.setattr(
        "sec_review_agents.memory.catalog_client.configured_memory_catalog_client",
        Mock(return_value=client),
    )

    result = maintenance_workflow.count_pending_memory_observations_activity()

    assert result == {
        "ok": True,
        "skipped": False,
        "pending_count": 2,
        "oldest_pending_created_at": "2026-01-01T00:00:00+00:00",
    }
    client.get_observation_backlog.assert_called_once_with()


@pytest.mark.asyncio
async def test_scheduled_maintenance_skips_below_threshold(monkeypatch) -> None:
    execute = AsyncMock(
        return_value={
            "ok": True,
            "pending_count": 1,
            "oldest_pending_created_at": None,
        }
    )
    monkeypatch.setattr(maintenance_workflow.workflow, "execute_activity", execute)
    monkeypatch.setattr(
        maintenance_workflow.workflow,
        "now",
        lambda: maintenance_workflow.datetime.fromisoformat(
            "2026-01-01T00:00:00+00:00"
        ),
    )
    result = await MemoryMaintenanceWorkflow().run(
        MemoryMaintenanceRequest(timeout_seconds=30, require_threshold=True)
    )
    assert result["reason"] == "below_threshold"
    assert result["skipped"] is True
    assert execute.call_count == 1


@pytest.mark.asyncio
async def test_manual_maintenance_runs_without_threshold(monkeypatch) -> None:
    results = iter(
        [
            {"ok": True, "pending_count": 1, "oldest_pending_created_at": None},
            MemoryMaintenancePreparationResult(
                kind="complete",
                summary="No pending memory observations selected.",
            ),
            {"ok": True, "pending_count": 0, "oldest_pending_created_at": None},
        ]
    )

    async def execute(*_args, **_kwargs):
        return next(results)

    monkeypatch.setattr(maintenance_workflow.workflow, "execute_activity", execute)
    assert await MemoryMaintenanceWorkflow().run(
        MemoryMaintenanceRequest(timeout_seconds=30)
    ) == {
        "ok": True,
        "skipped": True,
        "summary": "No pending memory observations selected.",
        "processed_count": 0,
    }


@pytest.mark.asyncio
async def test_coordinated_maintenance_commits_recorded_preparation(
    monkeypatch,
) -> None:
    revision_creation = _revision_creation()
    results = iter(
        [
            {"ok": True, "pending_count": 1, "oldest_pending_created_at": None},
            MemoryMaintenancePreparationResult(
                kind="prepared",
                revision_creation=revision_creation,
            ),
            {"ok": True, "processed_count": 1},
            {"ok": True, "pending_count": 0, "oldest_pending_created_at": None},
        ]
    )
    calls: list[tuple[object, object | None]] = []

    async def execute(activity_fn, argument=None, **_kwargs):
        calls.append((activity_fn, argument))
        return next(results)

    monkeypatch.setattr(maintenance_workflow.workflow, "execute_activity", execute)

    result = await MemoryMaintenanceWorkflow().run(
        MemoryMaintenanceRequest(timeout_seconds=30)
    )

    assert result == {"ok": True, "processed_count": 1}
    assert calls[1] == (
        maintenance_workflow.prepare_memory_maintenance_activity,
        MemoryMaintenanceRequest(timeout_seconds=30),
    )
    assert calls[2] == (
        maintenance_workflow.commit_memory_tree_revision_activity,
        revision_creation,
    )


@pytest.mark.asyncio
async def test_maintenance_workflow_retries_commit_with_history_revision() -> None:
    revision_creation = MemoryTreeRevisionCreation(
        maintenance_id="maintenance-run-1",
        base_revision=3,
        extraction_ids=("extraction-1", "extraction-2"),
        memory_tree_reference=_reference(),
        maintenance_transcript_reference=ArtifactReference(
            uri=(
                "s3://sec-review/memory/transcripts/memory-maintainer/"
                "transcript.v1.jsonl.zst"
            ),
            digest=f"sha256:{'b' * 64}",
            media_type="application/zstd",
            size_bytes=10,
        ),
    )
    prepare_calls = 0
    commit_revisions: list[MemoryTreeRevisionCreation] = []

    @activity.defn(name="count_pending_memory_observations_activity")
    def fake_pending_summary() -> dict[str, Any]:
        return {
            "ok": True,
            "skipped": False,
            "pending_count": 1,
            "oldest_pending_created_at": None,
        }

    @activity.defn(name="prepare_memory_maintenance_activity")
    async def fake_prepare(
        _request: MemoryMaintenanceRequest,
    ) -> MemoryMaintenancePreparationResult:
        nonlocal prepare_calls
        prepare_calls += 1
        return MemoryMaintenancePreparationResult(
            kind="prepared",
            revision_creation=revision_creation,
        )

    @activity.defn(name="commit_memory_tree_revision_activity")
    def fake_commit(revision: MemoryTreeRevisionCreation) -> dict[str, Any]:
        commit_revisions.append(revision)
        if len(commit_revisions) == 1:
            raise RuntimeError("response lost after catalog persistence")
        return {
            "ok": True,
            "skipped": False,
            "summary": "Processed 2 memory observations.",
            "processed_count": 2,
        }

    request = MemoryMaintenanceRequest(timeout_seconds=30)
    async with temporal_time_skipping_environment() as env:
        with ThreadPoolExecutor(max_workers=2) as executor:
            async with Worker(
                env.client,
                task_queue="memory-maintenance-retry-test",
                workflows=[MemoryMaintenanceWorkflow],
                activities=[fake_pending_summary, fake_prepare, fake_commit],
                activity_executor=executor,
            ):
                result = await env.client.execute_workflow(
                    MemoryMaintenanceWorkflow.run,
                    request,
                    id="memory-maintenance-retry-test",
                    task_queue="memory-maintenance-retry-test",
                )

    assert result == {
        "ok": True,
        "skipped": False,
        "summary": "Processed 2 memory observations.",
        "processed_count": 2,
    }
    assert prepare_calls == 1
    assert commit_revisions == [revision_creation, revision_creation]


@pytest.mark.asyncio
async def test_catalog_revision_conflict_is_not_retried(monkeypatch) -> None:
    from temporalio.exceptions import ApplicationError

    from sec_review_agents.memory.catalog_client import MemoryCatalogConflictError

    def conflict(**_kwargs):
        raise MemoryCatalogConflictError("stale base revision")

    monkeypatch.setattr(
        "sec_review_agents.memory.catalog_client.configured_memory_catalog_client",
        Mock(return_value=SimpleNamespace(create_memory_tree_revision=conflict)),
    )

    with pytest.raises(ApplicationError) as captured:
        maintenance_workflow.commit_memory_tree_revision_activity(_revision_creation())

    assert captured.value.type == "MEMORY_CATALOG_REVISION_CONFLICT"
    assert captured.value.non_retryable is True


def test_commit_memory_tree_revision_uses_prepared_payload_after_processing_is_disabled(
    monkeypatch,
) -> None:
    client = Mock()
    client.create_memory_tree_revision.return_value = {
        "created": True,
        "revision": 4,
        "maintenance_id": "maintenance-run-1",
    }
    monkeypatch.setenv("AGENT_MEMORY_PROCESSING_ENABLED", "false")
    monkeypatch.setattr(
        "sec_review_agents.memory.catalog_client.configured_memory_catalog_client",
        Mock(return_value=client),
    )
    prepared = _revision_creation(extraction_ids=("extraction-1", "extraction-2"))

    assert maintenance_workflow.commit_memory_tree_revision_activity(prepared) == {
        "ok": True,
        "skipped": False,
        "summary": "Processed 2 memory observations.",
        "processed_count": 2,
    }
    client.create_memory_tree_revision.assert_called_once_with(
        maintenance_id="maintenance-run-1",
        base_revision=3,
        extraction_ids=["extraction-1", "extraction-2"],
        memory_tree_reference=_reference(),
        maintenance_transcript_reference=_reference(),
    )


def test_commit_memory_tree_revision_retry_reuses_prepared_references(
    monkeypatch,
) -> None:
    client = Mock()
    client.create_memory_tree_revision.return_value = {
        "created": False,
        "revision": 4,
        "maintenance_id": "maintenance-run-1",
    }
    monkeypatch.setattr(
        "sec_review_agents.memory.catalog_client.configured_memory_catalog_client",
        Mock(return_value=client),
    )
    prepared = _revision_creation(extraction_ids=("extraction-1", "extraction-2"))

    first = maintenance_workflow.commit_memory_tree_revision_activity(prepared)
    second = maintenance_workflow.commit_memory_tree_revision_activity(prepared)

    assert first["processed_count"] == second["processed_count"] == 2
    expected = {
        "maintenance_id": "maintenance-run-1",
        "base_revision": 3,
        "extraction_ids": ["extraction-1", "extraction-2"],
        "memory_tree_reference": _reference(),
        "maintenance_transcript_reference": _reference(),
    }
    assert client.create_memory_tree_revision.call_count == 2
    assert client.create_memory_tree_revision.call_args_list[0].kwargs == expected
    assert client.create_memory_tree_revision.call_args_list[1].kwargs == expected
