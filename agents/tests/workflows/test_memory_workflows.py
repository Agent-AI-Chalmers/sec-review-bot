from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.workflows.memory import (
    extraction as extraction_workflow,
)
from sec_review_agents.workflows.memory import (
    maintenance as maintenance_workflow,
)
from sec_review_agents.workflows.memory.extraction import (
    MemoryExtractionRequest,
    MemoryExtractionWorkflow,
    memory_extraction_workflow_id,
    run_memory_extraction,
)
from sec_review_agents.workflows.memory.maintenance import (
    MemoryMaintenanceRequest,
    MemoryMaintenanceWorkflow,
)


def _reference() -> ArtifactReference:
    return ArtifactReference(
        uri="s3://sec-review/runs/run-1/artifacts/diagnostic-tree.v1.tar.zst",
        digest=f"sha256:{'a' * 64}",
        media_type="application/tar+zstd",
        size_bytes=42,
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
async def test_extraction_workflow_executes_one_activity(monkeypatch) -> None:
    request = MemoryExtractionRequest(
        source_workflow="issue-review",
        run_id="run-1",
        review_unit_id="review",
        diagnostic_bundle=_reference().as_dict(),
        timeout_seconds=30,
    )
    execute = AsyncMock(return_value={"ok": True})
    monkeypatch.setattr(extraction_workflow.workflow, "execute_activity", execute)

    assert await MemoryExtractionWorkflow().run(request) == {"ok": True}
    assert execute.call_args.args == (
        extraction_workflow.run_memory_extraction_activity,
        request,
    )


@pytest.mark.asyncio
async def test_coordinated_extraction_registers_observation_with_provenance(
    monkeypatch,
    tmp_path: Path,
) -> None:
    transcript = tmp_path / "transcript.jsonl"
    transcript.write_text("{}\n", encoding="utf-8")
    client = Mock()
    preview = SimpleNamespace(
        extraction_id="observation-1",
        observation_markdown="Remember this.",
        skipped=False,
        summary="Produced observation.",
        agent_transcript_path=tmp_path / "memory-extractor.jsonl",
    )
    extraction_transcript = ArtifactReference(
        uri="s3://sec-review/memory/transcripts/memory-extractor/transcript.v1.jsonl.zst",
        digest=f"sha256:{'b' * 64}",
        media_type="application/zstd",
        size_bytes=10,
    )

    monkeypatch.setattr(
        "sec_review_agents.memory.catalog_client.configured_memory_catalog_client",
        lambda: client,
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

    result = await run_memory_extraction(request)

    assert result["extraction_id"] == memory_extraction_workflow_id(
        diagnostic_bundle_digest=_reference().digest,
        review_unit_id="review",
    )
    assert result["observation_produced"] is True
    client.register_extraction.assert_called_once_with(
        extraction_id=result["extraction_id"],
        source_workflow="issue-review",
        source_run_id="run-1",
        source_review_unit_id="review",
        diagnostic_bundle_digest=_reference().digest,
        transcript_reference=extraction_transcript,
        observation_markdown="Remember this.",
    )


@pytest.mark.asyncio
async def test_coordinated_extraction_registers_no_observation_outcome(
    monkeypatch,
    tmp_path: Path,
) -> None:
    transcript = tmp_path / "transcript.jsonl"
    transcript.write_text("{}\n", encoding="utf-8")
    client = Mock()
    preview = SimpleNamespace(
        extraction_id="ignored-preview-id",
        observation_markdown=None,
        skipped=True,
        summary="No durable memory observation produced.",
        agent_transcript_path=tmp_path / "memory-extractor.jsonl",
    )
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
        lambda **_kwargs: transcript_reference,
    )
    request = MemoryExtractionRequest(
        source_workflow="issue-review",
        run_id="run-1",
        review_unit_id="review",
        diagnostic_bundle=_reference().as_dict(),
        timeout_seconds=30,
    )

    result = await run_memory_extraction(request)

    assert result["observation_produced"] is False
    client.register_extraction.assert_called_once_with(
        extraction_id=result["extraction_id"],
        source_workflow="issue-review",
        source_run_id="run-1",
        source_review_unit_id="review",
        diagnostic_bundle_digest=_reference().digest,
        transcript_reference=transcript_reference,
        observation_markdown=None,
    )


@pytest.mark.asyncio
async def test_catalog_extraction_conflict_is_not_retried(monkeypatch) -> None:
    from temporalio.exceptions import ApplicationError

    from sec_review_agents.memory.catalog_client import MemoryCatalogConflictError
    from sec_review_agents.workflows.memory.extraction import (
        run_memory_extraction_activity,
    )

    async def conflict(_request):
        raise MemoryCatalogConflictError("extraction content differs")

    monkeypatch.setattr(extraction_workflow, "run_memory_extraction", conflict)
    request = MemoryExtractionRequest(
        source_workflow="issue-review",
        run_id="run-1",
        review_unit_id="review",
        diagnostic_bundle=_reference().as_dict(),
        timeout_seconds=30,
    )

    with pytest.raises(ApplicationError) as captured:
        await run_memory_extraction_activity(request)

    assert captured.value.type == "MEMORY_CATALOG_EXTRACTION_CONFLICT"
    assert captured.value.non_retryable is True


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
    run_extraction = AsyncMock()
    monkeypatch.setattr(extraction_workflow, "run_memory_extraction", run_extraction)
    monkeypatch.setenv("AGENT_MEMORY_PROCESSING_ENABLED", "false")

    assert await extraction_workflow.run_memory_extraction_activity(request) == {
        "ok": True,
        "skipped": True,
        "reason": "AGENT_MEMORY_PROCESSING_ENABLED is false.",
    }
    run_extraction.assert_not_awaited()


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
            {"ok": True, "processed_count": 1},
            {"ok": True, "pending_count": 0, "oldest_pending_created_at": None},
        ]
    )

    async def execute(*_args, **_kwargs):
        return next(results)

    monkeypatch.setattr(maintenance_workflow.workflow, "execute_activity", execute)
    assert await MemoryMaintenanceWorkflow().run(
        MemoryMaintenanceRequest(timeout_seconds=30)
    ) == {"ok": True, "processed_count": 1}
