import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from sec_review_agents.delivery_stages.model import DeliveryEntry, DeliveryPlan
from sec_review_agents.workflows.repository import direct
from sec_review_agents.workflows.repository_case.result import RepositoryCaseResult
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest
from sec_review_agents.workspace.patches import PatchArtifact
from tests.prepared_input_fixtures import prepared_repository_input


def delivery_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, combined_count: int = 5
):
    monkeypatch.delenv("REPOSITORY_PATCH_SYNTHESIS_MAX_CONCURRENCY", raising=False)
    deliveries = [
        DeliveryEntry(
            delivery_id=f"combined-{index}",
            strategy="combined",
            case_ids=[f"case-{index}-a", f"case-{index}-b"],
            reason="Combined repair.",
        )
        for index in range(combined_count)
    ]
    deliveries.insert(
        1,
        DeliveryEntry(
            delivery_id="single-0",
            strategy="single",
            case_ids=["single-case-0"],
            reason="Independent repair.",
        ),
    )
    deliveries.append(
        DeliveryEntry(
            delivery_id="single-1",
            strategy="single",
            case_ids=["single-case-1"],
            reason="Independent repair.",
        )
    )
    cases = [
        RepositoryCaseResult.model_validate(
            {
                "case_id": case_id,
                "disposition": "keep",
                "review_record": {
                    "mitigation": {
                        "file_changes": [
                            {"path": f"{case_id}.py", "status": "deleted"}
                        ],
                        "patch_diff": f"patch for {case_id}",
                    }
                },
            }
        )
        for entry in deliveries
        for case_id in entry.case_ids
    ]
    plan = DeliveryPlan.model_validate(
        {
            "status": "completed",
            "metadata": {
                "planning_mode": "single",
                "planning_pass_count": 1,
                "batch_size": None,
            },
            "counts": {
                "input_case_count": len(cases),
                "delivery_count": len(deliveries),
            },
            "deliveries": deliveries,
        }
    )
    monkeypatch.setattr(
        direct, "plan_repository_delivery_activity", AsyncMock(return_value=plan)
    )
    request = ReviewWorkflowRequest(
        workflow="repository-review",
        run_id="run-delivery",
        timeout_seconds=30,
        runtime_context={},
        prepared_input=prepared_repository_input(
            artifact_root_path=str(tmp_path / "artifacts"),
            workspace_snapshot_tar_path=str(tmp_path / "baseline.tar"),
        ),
    )
    return request, cases, deliveries


def patch_for(delivery: DeliveryEntry) -> PatchArtifact:
    return PatchArtifact(
        patch_diff=f"patch for {delivery.delivery_id}",
        file_changes=[{"path": f"{delivery.delivery_id}.py", "status": "deleted"}],
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("configured", "expected"), [(None, 4), ("1", 1), ("2", 2), ("20", 5)]
)
async def test_direct_combined_delivery_honors_concurrency_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    configured: str | None,
    expected: int,
) -> None:
    request, cases, deliveries = delivery_run(tmp_path, monkeypatch)
    if configured is not None:
        monkeypatch.setenv("REPOSITORY_PATCH_SYNTHESIS_MAX_CONCURRENCY", configured)
    full = asyncio.Event()
    release = asyncio.Event()
    active = 0
    peak = 0
    started: list[str] = []

    async def synthesize(*, delivery_entry, **kwargs):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        started.append(delivery_entry.delivery_id)
        if active == expected:
            full.set()
        try:
            await release.wait()
            return patch_for(delivery_entry)
        finally:
            active -= 1

    monkeypatch.setattr(
        "sec_review_agents.delivery_stages.execution.stage.synthesize_combined_delivery_patch",
        synthesize,
    )
    baseline = asyncio.all_tasks()
    run = asyncio.create_task(direct.run_repository_delivery_direct(request, cases))
    try:
        await asyncio.wait_for(full.wait(), timeout=2)
        assert len(started) == expected
        # The scheduler must bound pending work too, rather than queueing one task per delivery.
        assert len(asyncio.all_tasks() - baseline) <= expected + 1
        release.set()
        result = await asyncio.wait_for(run, timeout=2)
    finally:
        release.set()
        if not run.done():
            run.cancel()
        await asyncio.gather(run, return_exceptions=True)
    assert peak == expected
    assert active == 0
    assert len(started) == 5
    assert [item.delivery_id for item in result.deliveries] == [
        item.delivery_id for item in deliveries
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_second", [False, True])
async def test_direct_delivery_refills_before_slow_peer_finishes_and_preserves_plan_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fail_second: bool
) -> None:
    """A completed or failed slot must admit the next delivery without a batch barrier."""
    request, cases, deliveries = delivery_run(tmp_path, monkeypatch)
    monkeypatch.setenv("REPOSITORY_PATCH_SYNTHESIS_MAX_CONCURRENCY", "2")
    started = [asyncio.Event() for _ in range(5)]
    release = [asyncio.Event() for _ in range(5)]
    completed: list[int] = []

    async def synthesize(*, delivery_entry, **kwargs):
        index = int(delivery_entry.delivery_id.split("-")[1])
        started[index].set()
        await release[index].wait()
        completed.append(index)
        if index == 1 and fail_second:
            raise RuntimeError("One synthesis failed.")
        return patch_for(delivery_entry)

    monkeypatch.setattr(
        "sec_review_agents.delivery_stages.execution.stage.synthesize_combined_delivery_patch",
        synthesize,
    )
    run = asyncio.create_task(direct.run_repository_delivery_direct(request, cases))
    try:
        await asyncio.wait_for(started[0].wait(), timeout=2)
        await asyncio.wait_for(started[1].wait(), timeout=2)
        for index in range(1, 5):
            release[index].set()
            if index < 4:
                await asyncio.wait_for(started[index + 1].wait(), timeout=2)
                assert 0 not in completed
        release[0].set()
        result = await asyncio.wait_for(run, timeout=2)
    finally:
        for event in release:
            event.set()
        if not run.done():
            run.cancel()
        await asyncio.gather(run, return_exceptions=True)
    assert sorted(completed) == list(range(5))
    expected = [
        entry.delivery_id
        for entry in deliveries
        if not (fail_second and entry.delivery_id == "combined-1")
    ]
    assert [entry.delivery_id for entry in result.deliveries] == expected
    persisted = json.loads(
        (tmp_path / "artifacts/delivery-execution/delivery-result.json").read_text()
    )
    assert [entry["delivery_id"] for entry in persisted["deliveries"]] == expected


@pytest.mark.asyncio
async def test_direct_delivery_cancellation_drains_active_synthesis(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A cancelled local run must not leave synthesis tasks writing artifacts in the background."""
    request, cases, _ = delivery_run(tmp_path, monkeypatch)
    monkeypatch.setenv("REPOSITORY_PATCH_SYNTHESIS_MAX_CONCURRENCY", "2")
    full = asyncio.Event()
    started: list[str] = []
    closed: list[str] = []

    async def synthesize(*, delivery_entry, **kwargs):
        started.append(delivery_entry.delivery_id)
        if len(started) == 2:
            full.set()
        try:
            await asyncio.Event().wait()
        finally:
            closed.append(delivery_entry.delivery_id)

    monkeypatch.setattr(
        "sec_review_agents.delivery_stages.execution.stage.synthesize_combined_delivery_patch",
        synthesize,
    )
    run = asyncio.create_task(direct.run_repository_delivery_direct(request, cases))
    try:
        await asyncio.wait_for(full.wait(), timeout=2)
        run.cancel()
        with pytest.raises(asyncio.CancelledError):
            await run
    finally:
        if not run.done():
            run.cancel()
        await asyncio.gather(run, return_exceptions=True)
    assert started == ["combined-0", "combined-1"]
    assert sorted(closed) == sorted(started)
    assert not (tmp_path / "artifacts/delivery-execution/delivery-result.json").exists()


@pytest.mark.asyncio
async def test_single_only_deliveries_do_not_call_synthesis(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request, cases, deliveries = delivery_run(tmp_path, monkeypatch, combined_count=0)
    synthesis = AsyncMock()
    monkeypatch.setattr(
        "sec_review_agents.delivery_stages.execution.stage.synthesize_combined_delivery_patch",
        synthesis,
    )
    result = await direct.run_repository_delivery_direct(request, cases)
    assert [entry.delivery_id for entry in result.deliveries] == [
        entry.delivery_id for entry in deliveries
    ]
    synthesis.assert_not_awaited()
