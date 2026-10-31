from typing import Any
from unittest.mock import AsyncMock

import pytest
from temporalio.client import Client
from temporalio.converter import DataConverter

from sec_review_agents.temporal import client as temporal_client


@pytest.mark.asyncio
async def test_connection_preserves_sdk_defaults_and_explicit_endpoint(
    monkeypatch,
) -> None:
    """Centralizing creation must not change the existing payload decoding policy."""
    sdk_connect = Client.connect

    async def connect_without_dialing(address: str, **kwargs: Any) -> Client:
        return await sdk_connect(address, lazy=True, **kwargs)

    connect = AsyncMock(side_effect=connect_without_dialing)
    monkeypatch.setattr(temporal_client.Client, "connect", connect)
    client = await temporal_client.connect_temporal_client(
        address="temporal.example:7233", namespace="reviews"
    )

    connect.assert_awaited_once_with("temporal.example:7233", namespace="reviews")
    assert client.namespace == "reviews"
    assert client.data_converter is DataConverter.default


@pytest.mark.asyncio
async def test_connection_failure_is_left_to_caller(monkeypatch) -> None:
    connect = AsyncMock(side_effect=RuntimeError("connection refused"))
    monkeypatch.setattr(temporal_client.Client, "connect", connect)
    with pytest.raises(RuntimeError, match="connection refused"):
        await temporal_client.connect_temporal_client(
            address="host:7233", namespace="ns"
        )
    assert connect.await_count == 1
