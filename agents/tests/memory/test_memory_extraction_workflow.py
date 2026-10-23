from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from temporalio.common import WorkflowIDReusePolicy

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.memory import extraction_workflow, maintenance_workflow
from sec_review_agents.memory.extraction_workflow import (
    MemoryExtractionRequest,
    MemoryExtractionWorkflow,
    TranscriptBundlePublicationRequest,
    memory_extraction_workflow_id,
    publish_and_start_memory_extractions,
    run_memory_extraction,
)
from sec_review_agents.memory.maintenance_workflow import (
    MemoryMaintenanceRequest,
    MemoryMaintenanceWorkflow,
)
from sec_review_agents.temporal.config import DEFAULT_MEMORY_TASK_QUEUE


def _reference() -> ArtifactReference:
    return ArtifactReference(
        uri="s3://sec-review/runs/run-1/transcripts/review.tar.zst",
        digest=f"sha256:{'a' * 64}",
        media_type="application/tar+zstd",
        size_bytes=42,
    )


def test_extraction_workflow_id_is_stable_per_transcript_unit() -> None:
    first = memory_extraction_workflow_id(
        transcript_digest=_reference().digest,
        review_unit_id="case-a",
    )
    assert first == memory_extraction_workflow_id(
        transcript_digest=_reference().digest,
        review_unit_id="case-a",
    )
    assert first != memory_extraction_workflow_id(
        transcript_digest=_reference().digest,
        review_unit_id="case-b",
    )


@pytest.mark.asyncio
async def test_publication_starts_one_abandoned_child_per_review_unit(
    monkeypatch,
) -> None:
    started = []

    async def fake_execute_activity(*_args, **_kwargs):
        return {
            "transcript_bundle": _reference().as_dict(),
            "review_unit_ids": ["case-a", "case-b"],
        }

    async def fake_start_child(*args, **kwargs):
        started.append((args, kwargs))

    monkeypatch.setattr(
        extraction_workflow.workflow, "execute_activity", fake_execute_activity
    )
    monkeypatch.setattr(
        extraction_workflow.workflow, "start_child_workflow", fake_start_child
    )

    result = await publish_and_start_memory_extractions(
        TranscriptBundlePublicationRequest(
            run_id="run-1",
            artifact_root_path="/tmp/run-1",
            review_units=[],
            timeout_seconds=30,
        ),
        source_workflow="repository-review",
        start_extractions=True,
    )

    assert result["transcript_publication"] == "published"
    assert [entry["status"] for entry in result["extractions"]] == [
        "started",
        "started",
    ]
    assert [call[0][1].review_unit_id for call in started] == ["case-a", "case-b"]
    assert all(
        call[1]["parent_close_policy"]
        is extraction_workflow.workflow.ParentClosePolicy.ABANDON
        for call in started
    )
    assert all(
        call[1]["id_reuse_policy"] is WorkflowIDReusePolicy.REJECT_DUPLICATE
        for call in started
    )
    assert all(call[1]["task_queue"] == DEFAULT_MEMORY_TASK_QUEUE for call in started)


@pytest.mark.asyncio
async def test_publication_reports_already_started_extraction(
    monkeypatch,
) -> None:
    async def fake_execute_activity(*_args, **_kwargs):
        return {
            "transcript_bundle": _reference().as_dict(),
            "review_unit_ids": ["case-a"],
        }

    async def already_started(*_args, **_kwargs):
        raise extraction_workflow.WorkflowAlreadyStartedError(
            "memory-extraction:test", "MemoryExtractionWorkflow"
        )

    monkeypatch.setattr(
        extraction_workflow.workflow, "execute_activity", fake_execute_activity
    )
    monkeypatch.setattr(
        extraction_workflow.workflow, "start_child_workflow", already_started
    )
    monkeypatch.setattr(extraction_workflow.workflow, "logger", Mock())

    result = await publish_and_start_memory_extractions(
        TranscriptBundlePublicationRequest("run-1", "/tmp/run-1", [], 30),
        source_workflow="issue-review",
        start_extractions=True,
    )

    assert result["extractions"] == [
        {
            "review_unit_id": "case-a",
            "workflow_id": memory_extraction_workflow_id(
                transcript_digest=_reference().digest,
                review_unit_id="case-a",
            ),
            "status": "already_started",
        }
    ]


@pytest.mark.asyncio
async def test_publication_failure_is_returned_as_postprocessing_metadata(
    monkeypatch,
) -> None:
    async def fail(*_args, **_kwargs):
        raise RuntimeError("storage unavailable")

    monkeypatch.setattr(extraction_workflow.workflow, "execute_activity", fail)
    monkeypatch.setattr(extraction_workflow.workflow, "logger", Mock())
    result = await publish_and_start_memory_extractions(
        TranscriptBundlePublicationRequest("run-1", "/tmp/run-1", [], 30),
        source_workflow="issue-review",
        start_extractions=True,
    )
    assert result == {
        "transcript_publication": "failed",
        "extractions": [],
        "error_code": "TRANSCRIPT_PUBLICATION_FAILED",
    }


@pytest.mark.asyncio
async def test_extraction_workflow_executes_one_activity(monkeypatch) -> None:
    request = MemoryExtractionRequest(
        source_workflow="issue-review",
        run_id="run-1",
        review_unit_id="review",
        transcript_bundle=_reference().as_dict(),
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
async def test_managed_extraction_registers_observation_with_provenance(
    monkeypatch,
    tmp_path: Path,
) -> None:
    transcript = tmp_path / "transcript.jsonl"
    transcript.write_text("{}\n", encoding="utf-8")
    client = Mock()
    preview = SimpleNamespace(
        observation_id="observation-1",
        observation_markdown="Remember this.",
        skipped=False,
        summary="Produced observation.",
    )
    audit = ArtifactReference(
        uri="s3://sec-review/memory/audit/extraction.tar.zst",
        digest=f"sha256:{'b' * 64}",
        media_type="application/tar+zstd",
        size_bytes=10,
    )

    monkeypatch.setattr(
        "sec_review_agents.memory.catalog_client.configured_memory_catalog_client",
        lambda: client,
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.transcript_bundle.materialize_transcript_unit",
        lambda *_args, **_kwargs: SimpleNamespace(transcript_paths=(transcript,)),
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.extractor.preview_memory_observation_from_paths",
        AsyncMock(return_value=preview),
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.audit_bundle.publish_memory_audit_bundle",
        lambda **_kwargs: audit,
    )
    request = MemoryExtractionRequest(
        source_workflow="issue-review",
        run_id="run-1",
        review_unit_id="review",
        transcript_bundle=_reference().as_dict(),
        timeout_seconds=30,
    )

    result = await run_memory_extraction(request)

    assert result["observation_id"] == "observation-1"
    client.register_observation.assert_called_once_with(
        observation_id="observation-1",
        source_workflow="issue-review",
        source_run_id="run-1",
        source_review_unit_id="review",
        transcript_digest=_reference().digest,
        body_markdown="Remember this.",
        audit_reference=audit,
    )


@pytest.mark.asyncio
async def test_catalog_observation_conflict_is_not_retried(monkeypatch) -> None:
    from temporalio.exceptions import ApplicationError

    from sec_review_agents.memory.catalog_client import MemoryCatalogConflictError
    from sec_review_agents.memory.extraction_workflow import (
        run_memory_extraction_activity,
    )

    async def conflict(_request):
        raise MemoryCatalogConflictError("observation content differs")

    monkeypatch.setattr(extraction_workflow, "run_memory_extraction", conflict)
    request = MemoryExtractionRequest(
        source_workflow="issue-review",
        run_id="run-1",
        review_unit_id="review",
        transcript_bundle=_reference().as_dict(),
        timeout_seconds=30,
    )

    with pytest.raises(ApplicationError) as captured:
        await run_memory_extraction_activity(request)

    assert captured.value.type == "MEMORY_CATALOG_OBSERVATION_CONFLICT"
    assert captured.value.non_retryable is True


@pytest.mark.asyncio
async def test_extraction_activity_skips_when_processing_is_disabled(
    monkeypatch,
) -> None:
    request = MemoryExtractionRequest(
        source_workflow="issue-review",
        run_id="run-1",
        review_unit_id="review",
        transcript_bundle=_reference().as_dict(),
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
