from types import SimpleNamespace
from typing import Any, Self
from unittest.mock import AsyncMock

import pytest

from sec_review_agents.entrypoints.service import worker as worker_module


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

    class FakeClient:
        connect = AsyncMock(return_value=object())

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
        monkeypatch.delenv("TEMPORAL_MAX_CONCURRENT_ACTIVITIES", raising=False)
    else:
        monkeypatch.setenv("TEMPORAL_MAX_CONCURRENT_ACTIVITIES", configured_value)
    monkeypatch.setattr(worker_module, "Client", FakeClient)
    monkeypatch.setattr(worker_module, "ThreadPoolExecutor", FakeExecutor)
    monkeypatch.setattr(worker_module, "Worker", FakeWorker)
    monkeypatch.setattr(
        worker_module,
        "ensure_configured_memory_schedules",
        AsyncMock(),
    )

    await worker_module.run_worker()

    assert captured["executor_max_workers"] == expected
    assert captured["worker_max_concurrent_activities"] == expected
    assert isinstance(captured["activity_executor"], FakeExecutor)


@pytest.mark.asyncio
async def test_worker_waits_for_temporal_instead_of_exiting(monkeypatch) -> None:
    """The worker starts with the control plane, so a refused connection is retried.

    Retrying here keeps a normal boot out of the journal; exiting instead made every
    start print a traceback until systemd's five second timer tried again.
    """
    client = object()
    connect = AsyncMock(
        side_effect=[
            RuntimeError("connection refused"),
            RuntimeError("connection refused"),
            client,
        ]
    )
    monkeypatch.setattr(worker_module, "Client", SimpleNamespace(connect=connect))
    monkeypatch.setattr(worker_module, "TEMPORAL_CONNECT_INITIAL_BACKOFF_SECONDS", 0.0)
    monkeypatch.setattr(worker_module, "TEMPORAL_CONNECT_MAX_BACKOFF_SECONDS", 0.0)
    monkeypatch.setattr(worker_module, "TEMPORAL_CONNECT_TIMEOUT_SECONDS", 30.0)
    monkeypatch.setenv("TEMPORAL_ADDRESS", "127.0.0.1:7233")

    assert await worker_module._connect_temporal_client() is client
    assert connect.await_count == 3


@pytest.mark.asyncio
async def test_worker_gives_up_when_temporal_never_arrives(monkeypatch) -> None:
    """The wait is bounded: a control plane that never starts must still fail."""
    connect = AsyncMock(side_effect=RuntimeError("connection refused"))
    monkeypatch.setattr(worker_module, "Client", SimpleNamespace(connect=connect))
    monkeypatch.setattr(worker_module, "TEMPORAL_CONNECT_TIMEOUT_SECONDS", 0.0)
    monkeypatch.setenv("TEMPORAL_ADDRESS", "127.0.0.1:7233")

    with pytest.raises(RuntimeError, match="connection refused"):
        await worker_module._connect_temporal_client()
    assert connect.await_count == 1
