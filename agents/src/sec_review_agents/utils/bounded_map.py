"""Shared bounded sliding-window scheduling for asyncio and Temporal workflows.

The scheduler owns task admission, ordered results, and cancellation cleanup;
callers own per-item failure handling. Supply asyncio.wait in ordinary async
code and workflow.wait inside Temporal workflows to preserve replay safety.
"""

import asyncio
import contextlib
from collections.abc import Awaitable, Callable, Collection, Coroutine, Sequence
from typing import Any, Protocol


class TaskWaiter(Protocol):
    def __call__[R](
        self, fs: Sequence[asyncio.Task[R]], *, return_when: str
    ) -> Awaitable[tuple[Collection[asyncio.Task[R]], Collection[asyncio.Task[R]]]]: ...


async def map_bounded[T, R](
    items: Sequence[T],
    operation: Callable[[T], Coroutine[Any, Any, R]],
    *,
    max_concurrency: int,
    wait: TaskWaiter,
) -> list[R]:
    """Apply an async operation through a bounded sliding window of tasks.

    Args:
        items: Indexable input data, not pre-created tasks or coroutines. Each
            element is passed to operation; elements may be business objects
            or indices into caller-owned data. The sequence must remain stable
            for the duration of the call.
        operation: Creates a coroutine for one input. It is called only when
            a window slot is available, and that coroutine is scheduled as a
            task immediately. Capture shared arguments in the callable.
            Handle expected per-item failures here if other items should
            continue; an unhandled exception aborts the map.
        max_concurrency: Positive upper bound on admitted, uncollected tasks.
            Completed tasks are collected before vacant slots are refilled,
            without waiting for slower peers in the window.
        wait: Use asyncio.wait in ordinary async code and workflow.wait inside
            Temporal workflows. Called with return_when=FIRST_COMPLETED.

    Returns:
        One result per input in input order, regardless of completion order.
        None results are retained. Empty input returns an empty list.

    Raises:
        ValueError: If max_concurrency is less than one, before starting work.

    If multiple tasks complete in the same wait, their results or exceptions
    are collected in admission order. On an unhandled exception or caller
    cancellation, remaining tasks are cancelled and awaited before propagation;
    exceptions from that cleanup do not replace the original exception.
    """
    if max_concurrency < 1:
        raise ValueError("max_concurrency must be positive")
    pending: dict[asyncio.Task[R], int] = {}
    results: dict[int, R] = {}
    next_index = 0
    try:
        while next_index < len(items) or pending:
            while next_index < len(items) and len(pending) < max_concurrency:
                pending[asyncio.create_task(operation(items[next_index]))] = next_index
                next_index += 1
            done, _ = await wait(tuple(pending), return_when=asyncio.FIRST_COMPLETED)
            # Stable admission order also determines which simultaneous error wins.
            for task, index in tuple(pending.items()):
                if task not in done:
                    continue
                del pending[task]
                results[index] = await task
    finally:
        for task in pending:
            task.cancel()
        for task in pending:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
    return [results[index] for index in range(len(items))]
