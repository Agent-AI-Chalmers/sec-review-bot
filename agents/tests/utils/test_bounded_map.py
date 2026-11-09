import asyncio

import pytest

from sec_review_agents.utils.bounded_map import map_bounded


@pytest.mark.asyncio
async def test_empty_and_none_results_remain_distinct():
    async def operation(item: int) -> int | None:
        return None if item == 1 else item

    assert await map_bounded([], operation, max_concurrency=2, wait=asyncio.wait) == []
    assert await map_bounded(
        [0, 1, 2], operation, max_concurrency=2, wait=asyncio.wait
    ) == [0, None, 2]


@pytest.mark.asyncio
async def test_invalid_limit_rejected_before_start():
    async def operation(item: int) -> int:
        raise AssertionError("must not start")

    with pytest.raises(ValueError):
        await map_bounded([0], operation, max_concurrency=0, wait=asyncio.wait)


@pytest.mark.asyncio
async def test_simultaneous_failures_choose_admission_order_and_are_drained():
    """Both failures must be consumed even though only the first propagates."""
    tasks = []
    gate = asyncio.Event()

    async def operation(item: int) -> int:
        tasks.append(asyncio.current_task())
        if len(tasks) == 2:
            gate.set()
        await gate.wait()
        raise ValueError(str(item))

    with pytest.raises(ValueError, match="^0$"):
        await map_bounded([0, 1, 2], operation, max_concurrency=2, wait=asyncio.wait)
    assert len(tasks) == 2
    assert all(task is not None and task.done() for task in tasks)
