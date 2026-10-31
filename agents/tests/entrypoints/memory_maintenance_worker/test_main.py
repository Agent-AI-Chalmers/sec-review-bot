from typing import Any, Self
from unittest.mock import AsyncMock

import pytest

from sec_review_agents.entrypoints.memory_maintenance_worker import (
    main as worker_module,
)
from sec_review_agents.workflows.memory.maintenance import (
    MemoryMaintenanceWorkflow,
    commit_memory_tree_revision_activity,
    count_pending_memory_observations_activity,
    prepare_memory_maintenance_activity,
)


@pytest.mark.asyncio
async def test_maintenance_worker_owns_maintenance_registration_and_schedule(
    monkeypatch,
) -> None:
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
    monkeypatch.setattr(worker_module, "connect_worker_client", connect)
    monkeypatch.setattr(worker_module, "ThreadPoolExecutor", FakeExecutor)
    monkeypatch.setattr(worker_module, "Worker", FakeWorker)
    monkeypatch.setattr(
        worker_module,
        "ensure_configured_memory_schedules",
        ensure_schedules,
    )

    await worker_module.run_worker()

    assert captured["task_queue"] == "sec-review-memory-maintenance"
    assert captured["workflows"] == [MemoryMaintenanceWorkflow]
    assert captured["activities"] == [
        count_pending_memory_observations_activity,
        commit_memory_tree_revision_activity,
        prepare_memory_maintenance_activity,
    ]
    assert captured["max_concurrent_activities"] == 1
    ensure_schedules.assert_awaited_once_with(
        connect.return_value,
        task_queue="sec-review-memory-maintenance",
    )


@pytest.mark.asyncio
async def test_maintenance_worker_rejects_concurrency_above_one_before_connecting(
    monkeypatch,
) -> None:
    monkeypatch.setenv(
        "TEMPORAL_MEMORY_MAINTENANCE_MAX_CONCURRENT_ACTIVITIES",
        "2",
    )
    connect = AsyncMock()
    monkeypatch.setattr(worker_module, "connect_worker_client", connect)

    with pytest.raises(
        ValueError,
        match=(
            "TEMPORAL_MEMORY_MAINTENANCE_MAX_CONCURRENT_ACTIVITIES " "must be at most 1"
        ),
    ):
        await worker_module.run_worker()

    connect.assert_not_awaited()
