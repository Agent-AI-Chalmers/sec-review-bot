from unittest.mock import AsyncMock

import pytest

from sec_review_agents.temporal import client as temporal_client
from sec_review_agents.workflows.prepared_input import PreparedRepositoryInput
from tests.prepared_input_fixtures import prepared_repository_input


@pytest.mark.asyncio
async def test_connection_restores_nested_workflow_models(monkeypatch) -> None:
    """The configured converter must restore models across the actual payload boundary."""
    client = object()
    connect = AsyncMock(return_value=client)
    monkeypatch.setattr(temporal_client.Client, "connect", connect)
    assert (
        await temporal_client.connect_temporal_client(
            address="temporal.example:7233", namespace="reviews"
        )
        is client
    )
    assert connect.call_args.args == ("temporal.example:7233",)
    assert connect.call_args.kwargs["namespace"] == "reviews"
    converter = connect.call_args.kwargs["data_converter"]
    original = prepared_repository_input()
    payloads = await converter.encode([original])
    (restored,) = await converter.decode(payloads, [PreparedRepositoryInput])
    assert isinstance(restored, PreparedRepositoryInput)
    assert type(restored.scan_scope) is type(original.scan_scope)
    assert restored == original


@pytest.mark.asyncio
async def test_connection_failure_is_left_to_caller(monkeypatch) -> None:
    connect = AsyncMock(side_effect=RuntimeError("connection refused"))
    monkeypatch.setattr(temporal_client.Client, "connect", connect)
    with pytest.raises(RuntimeError, match="connection refused"):
        await temporal_client.connect_temporal_client(
            address="host:7233", namespace="ns"
        )
    assert connect.await_count == 1
