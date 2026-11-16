"""The repository's batch draft stages share one bounded-window policy."""

import asyncio
from collections.abc import Coroutine
from pathlib import Path
from typing import Any

import pytest

from sec_review_agents.delivery_stages.planning import stage as delivery
from sec_review_agents.scan_stages.triage import stage as triage


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["triage", "delivery"])
@pytest.mark.parametrize("outcome", ["success", "failure", "cancel"])
async def test_draft_window_bounds_tasks_refills_and_drains(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stage: str, outcome: str
) -> None:
    """A failed/cancelled batch must leave no drafts running against discarded state."""
    started = [asyncio.Event() for _ in range(6)]
    release = [asyncio.Event() for _ in range(6)]
    closed: list[int] = []
    error = RuntimeError("Draft failed.")

    async def draft(*, batch_index, **kwargs):
        index = batch_index - 1
        started[index].set()
        try:
            await release[index].wait()
            if index == 1 and outcome == "failure":
                raise error
            return []
        finally:
            closed.append(index)

    refinement_calls: list[str] = []

    async def refine(*, phase, **kwargs):
        assert sorted(closed) == list(range(6))
        refinement_calls.append(phase)

    operation: Coroutine[Any, Any, tuple[object, int]]
    if stage == "triage":
        monkeypatch.setattr(
            triage,
            "triage_candidate_batches",
            lambda *args, **kwargs: [[] for _ in range(6)],
        )
        monkeypatch.setattr(triage, "_run_triage_batch_draft", draft)
        monkeypatch.setattr(triage, "_invoke_triage_agent", refine)
        operation = triage._run_batched_triage(
            triage_root=tmp_path,
            triage_candidates=[],
            max_batch_size=1,
        )
    else:
        monkeypatch.setattr(
            delivery,
            "planning_case_id_batches",
            lambda *args, **kwargs: [[] for _ in range(6)],
        )
        monkeypatch.setattr(delivery, "_run_delivery_planning_batch_draft", draft)
        monkeypatch.setattr(delivery, "_invoke_delivery_planner", refine)
        operation = delivery._run_batched_delivery_planning(
            delivery_planning_root=tmp_path,
            planning_cases=[],
            max_batch_size=1,
        )

    baseline = asyncio.all_tasks()
    run = asyncio.create_task(operation)
    try:
        for index in range(3):
            await asyncio.wait_for(started[index].wait(), timeout=2)
        assert not any(event.is_set() for event in started[3:])
        assert len(asyncio.all_tasks() - baseline) <= 4
        if outcome == "cancel":
            run.cancel()
            with pytest.raises(asyncio.CancelledError):
                await run
        elif outcome == "failure":
            release[1].set()
            with pytest.raises(RuntimeError) as captured:
                await asyncio.wait_for(run, timeout=2)
            assert captured.value is error
        else:
            for previous, next_index in [(1, 3), (3, 4), (4, 5)]:
                release[previous].set()
                await asyncio.wait_for(started[next_index].wait(), timeout=2)
                assert 0 not in closed
            for event in release:
                event.set()
            _, pass_count = await asyncio.wait_for(run, timeout=2)
            assert pass_count == 7
        assert refinement_calls == (["refinement"] if outcome == "success" else [])
        assert sorted(closed) == (list(range(6)) if outcome == "success" else [0, 1, 2])
        assert not (asyncio.all_tasks() - baseline)
    finally:
        for event in release:
            event.set()
        if not run.done():
            run.cancel()
        await asyncio.gather(run, return_exceptions=True)
