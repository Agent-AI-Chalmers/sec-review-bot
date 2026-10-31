"""Shared connection creation for Python Temporal workers and CLI commands."""

from temporalio.client import Client


async def connect_temporal_client(*, address: str, namespace: str) -> Client:
    """Connect once using the SDK's default payload converter.

    Entrypoints resolve environment variables and CLI overrides before calling
    this function. Worker startup retries belong to worker_runtime; CLI commands
    propagate connection failures immediately.
    """
    return await Client.connect(address, namespace=namespace)
