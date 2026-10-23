from typing import Any, Self
from unittest.mock import AsyncMock

import pytest

from sec_review_agents.entrypoints.execution_worker import main as worker_module


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("configured_value", "expected"),
    [
        (None, 2),
        ("4", 4),
    ],
)
async def test_worker_applies_activity_concurrency_to_temporal_and_executor(
    monkeypatch,
    configured_value: str | None,
    expected: int,
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
            captured["worker_max_concurrent_activities"] = kwargs[
                "max_concurrent_activities"
            ]
            captured["activity_executor"] = kwargs["activity_executor"]

        async def run(self) -> None:
            return None

    if configured_value is None:
        monkeypatch.delenv(
            "TEMPORAL_EXECUTION_MAX_CONCURRENT_ACTIVITIES", raising=False
        )
    else:
        monkeypatch.setenv(
            "TEMPORAL_EXECUTION_MAX_CONCURRENT_ACTIVITIES", configured_value
        )
    monkeypatch.setattr(worker_module, "connect_temporal_client", AsyncMock())
    monkeypatch.setattr(worker_module, "ThreadPoolExecutor", FakeExecutor)
    monkeypatch.setattr(worker_module, "Worker", FakeWorker)
    await worker_module.run_worker()

    assert captured["executor_max_workers"] == expected
    assert captured["worker_max_concurrent_activities"] == expected
    assert isinstance(captured["activity_executor"], FakeExecutor)


@pytest.mark.asyncio
async def test_worker_rejects_invalid_concurrency_before_connecting(
    monkeypatch,
) -> None:
    monkeypatch.setenv("TEMPORAL_EXECUTION_MAX_CONCURRENT_ACTIVITIES", "many")
    connect = AsyncMock()
    monkeypatch.setattr(worker_module, "connect_temporal_client", connect)

    with pytest.raises(
        ValueError,
        match="TEMPORAL_EXECUTION_MAX_CONCURRENT_ACTIVITIES must be a decimal integer",
    ):
        await worker_module.run_worker()

    connect.assert_not_awaited()
