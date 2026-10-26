from unittest.mock import Mock

import pytest
from temporalio.common import WorkflowIDReusePolicy

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.temporal.config import DEFAULT_MEMORY_EXTRACTION_TASK_QUEUE
from sec_review_agents.workflows.memory import scheduling as memory_scheduling
from sec_review_agents.workflows.memory.extraction import memory_extraction_workflow_id
from sec_review_agents.workflows.memory.scheduling import schedule_memory_extractions


def _reference() -> ArtifactReference:
    return ArtifactReference(
        uri="s3://sec-review/runs/run-1/artifacts/diagnostic-tree.v1.tar.zst",
        digest=f"sha256:{'a' * 64}",
        media_type="application/tar+zstd",
        size_bytes=42,
    )


@pytest.mark.asyncio
async def test_scheduling_starts_one_abandoned_child_per_review_unit(
    monkeypatch,
) -> None:
    started = []

    async def fake_start_child(*args, **kwargs):
        started.append((args, kwargs))

    monkeypatch.setattr(
        memory_scheduling.workflow,
        "start_child_workflow",
        fake_start_child,
    )

    result = await schedule_memory_extractions(
        source_workflow="repository-review",
        run_id="run-1",
        diagnostic_bundle=_reference().as_dict(),
        unit_ids=["case-a", "case-b"],
        timeout_seconds=30,
        enabled=True,
    )

    assert [entry["status"] for entry in result["extractions"]] == [
        "started",
        "started",
    ]
    assert [call[0][1].unit_id for call in started] == ["case-a", "case-b"]
    assert all(
        call[1]["parent_close_policy"]
        is memory_scheduling.workflow.ParentClosePolicy.ABANDON
        for call in started
    )
    assert all(
        call[1]["id_reuse_policy"] is WorkflowIDReusePolicy.REJECT_DUPLICATE
        for call in started
    )
    assert all(
        call[1]["task_queue"] == DEFAULT_MEMORY_EXTRACTION_TASK_QUEUE
        for call in started
    )


@pytest.mark.asyncio
async def test_scheduling_reports_an_existing_extraction(monkeypatch) -> None:
    async def already_started(*_args, **_kwargs):
        raise memory_scheduling.WorkflowAlreadyStartedError(
            "memory-extraction:test", "MemoryExtractionWorkflow"
        )

    monkeypatch.setattr(
        memory_scheduling.workflow,
        "start_child_workflow",
        already_started,
    )
    monkeypatch.setattr(memory_scheduling.workflow, "logger", Mock())

    result = await schedule_memory_extractions(
        source_workflow="issue-review",
        run_id="run-1",
        diagnostic_bundle=_reference().as_dict(),
        unit_ids=["case-a"],
        timeout_seconds=30,
        enabled=True,
    )

    assert result["extractions"] == [
        {
            "unit_id": "case-a",
            "workflow_id": memory_extraction_workflow_id(
                diagnostic_bundle_digest=_reference().digest,
                unit_id="case-a",
            ),
            "status": "already_started",
        }
    ]


@pytest.mark.asyncio
async def test_disabled_scheduling_does_not_start_children(monkeypatch) -> None:
    start_child = Mock()
    monkeypatch.setattr(
        memory_scheduling.workflow,
        "start_child_workflow",
        start_child,
    )

    result = await schedule_memory_extractions(
        source_workflow="issue-review",
        run_id="run-1",
        diagnostic_bundle=_reference().as_dict(),
        unit_ids=["review"],
        timeout_seconds=30,
        enabled=False,
    )

    assert result == {"extractions": []}
    start_child.assert_not_called()
