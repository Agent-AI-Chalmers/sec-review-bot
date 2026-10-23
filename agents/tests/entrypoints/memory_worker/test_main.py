from typing import Any, Self
from unittest.mock import AsyncMock

import pytest

from sec_review_agents.entrypoints.memory_worker import main as worker_module
from sec_review_agents.memory.extraction_workflow import MemoryExtractionWorkflow
from sec_review_agents.memory.maintenance_workflow import MemoryMaintenanceWorkflow


@pytest.mark.asyncio
async def test_memory_worker_owns_memory_registration_and_schedule(monkeypatch) -> None:
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

    ensure_schedules = AsyncMock()
    connect = AsyncMock(return_value=object())
    monkeypatch.setattr(worker_module, "connect_temporal_client", connect)
    monkeypatch.setattr(worker_module, "ThreadPoolExecutor", FakeExecutor)
    monkeypatch.setattr(worker_module, "Worker", FakeWorker)
    monkeypatch.setattr(
        worker_module, "ensure_configured_memory_schedules", ensure_schedules
    )

    await worker_module.run_worker()

    assert captured["task_queue"] == "sec-review-memory"
    assert captured["workflows"] == [
        MemoryExtractionWorkflow,
        MemoryMaintenanceWorkflow,
    ]
    assert captured["max_concurrent_activities"] == 1
    ensure_schedules.assert_awaited_once_with(
        connect.return_value,
        task_queue="sec-review-memory",
    )


@pytest.mark.asyncio
async def test_memory_worker_rejects_invalid_concurrency_before_connecting(
    monkeypatch,
) -> None:
    monkeypatch.setenv("TEMPORAL_MEMORY_MAX_CONCURRENT_ACTIVITIES", "many")
    connect = AsyncMock()
    monkeypatch.setattr(worker_module, "connect_temporal_client", connect)

    with pytest.raises(
        ValueError,
        match="TEMPORAL_MEMORY_MAX_CONCURRENT_ACTIVITIES must be a decimal integer",
    ):
        await worker_module.run_worker()

    connect.assert_not_awaited()
