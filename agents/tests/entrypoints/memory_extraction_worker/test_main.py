from typing import Any, Self
from unittest.mock import AsyncMock

import pytest

from sec_review_agents.entrypoints.memory_extraction_worker import main as worker_module
from sec_review_agents.workflows.memory.extraction import (
    MemoryExtractionWorkflow,
    run_memory_extraction_activity,
)


@pytest.mark.asyncio
async def test_extraction_worker_owns_only_extraction_registration(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    class FakeExecutor:
        def __init__(self, *, max_workers: int) -> None:
            captured["executor_max_workers"] = max_workers

        def __enter__(self) -> Self:
            return self

        def __exit__(self, *args: object) -> None:
            return None

    class FakeWorker:
        def __init__(self, *args: object, **kwargs: Any) -> None:
            captured.update(kwargs)

        async def run(self) -> None:
            return None

    monkeypatch.setattr(worker_module, "connect_temporal_client", AsyncMock())
    monkeypatch.setattr(worker_module, "ThreadPoolExecutor", FakeExecutor)
    monkeypatch.setattr(worker_module, "Worker", FakeWorker)

    await worker_module.run_worker()

    assert captured["task_queue"] == "sec-review-memory-extraction"
    assert captured["workflows"] == [MemoryExtractionWorkflow]
    assert captured["activities"] == [run_memory_extraction_activity]
    assert captured["max_concurrent_activities"] == 4


@pytest.mark.asyncio
async def test_extraction_worker_rejects_invalid_concurrency_before_connecting(
    monkeypatch,
) -> None:
    monkeypatch.setenv(
        "TEMPORAL_MEMORY_EXTRACTION_MAX_CONCURRENT_ACTIVITIES",
        "many",
    )
    connect = AsyncMock()
    monkeypatch.setattr(worker_module, "connect_temporal_client", connect)

    with pytest.raises(
        ValueError,
        match=(
            "TEMPORAL_MEMORY_EXTRACTION_MAX_CONCURRENT_ACTIVITIES "
            "must be a decimal integer"
        ),
    ):
        await worker_module.run_worker()

    connect.assert_not_awaited()
