from unittest.mock import AsyncMock

import pytest

from sec_review_agents.temporal import worker_runtime


@pytest.mark.asyncio
async def test_connect_temporal_client_retries_startup_failures(monkeypatch) -> None:
    client = object()
    connect = AsyncMock(
        side_effect=[
            RuntimeError("connection refused"),
            RuntimeError("connection refused"),
            client,
        ]
    )
    monkeypatch.setattr(worker_runtime, "TEMPORAL_CONNECT_INITIAL_BACKOFF_SECONDS", 0.0)
    monkeypatch.setattr(worker_runtime, "TEMPORAL_CONNECT_MAX_BACKOFF_SECONDS", 0.0)
    monkeypatch.setattr(worker_runtime, "TEMPORAL_CONNECT_TIMEOUT_SECONDS", 30.0)

    assert await worker_runtime.connect_temporal_client(connect=connect) is client
    assert connect.await_count == 3


@pytest.mark.asyncio
async def test_connect_temporal_client_has_bounded_wait(monkeypatch) -> None:
    connect = AsyncMock(side_effect=RuntimeError("connection refused"))
    monkeypatch.setattr(worker_runtime, "TEMPORAL_CONNECT_TIMEOUT_SECONDS", 0.0)

    with pytest.raises(RuntimeError, match="connection refused"):
        await worker_runtime.connect_temporal_client(connect=connect)
    assert connect.await_count == 1
