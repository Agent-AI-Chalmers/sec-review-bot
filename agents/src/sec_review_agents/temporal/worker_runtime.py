import asyncio

from temporalio.client import Client

from sec_review_agents.temporal.client import connect_temporal_client
from sec_review_agents.temporal.config import (
    DEFAULT_TEMPORAL_ADDRESS,
    DEFAULT_TEMPORAL_NAMESPACE,
)
from sec_review_agents.utils.env import env_value

TEMPORAL_CONNECT_TIMEOUT_SECONDS = 60.0
TEMPORAL_CONNECT_INITIAL_BACKOFF_SECONDS = 1.0
TEMPORAL_CONNECT_MAX_BACKOFF_SECONDS = 8.0


async def connect_worker_client() -> Client:
    """Allow infrastructure to start before the worker gives up connecting.

    CLI connections deliberately do not inherit this startup retry policy.
    """
    address = env_value("TEMPORAL_ADDRESS") or DEFAULT_TEMPORAL_ADDRESS
    namespace = env_value("TEMPORAL_NAMESPACE") or DEFAULT_TEMPORAL_NAMESPACE
    deadline = asyncio.get_running_loop().time() + TEMPORAL_CONNECT_TIMEOUT_SECONDS
    backoff = TEMPORAL_CONNECT_INITIAL_BACKOFF_SECONDS
    while True:
        try:
            return await connect_temporal_client(address=address, namespace=namespace)
        except Exception:
            if asyncio.get_running_loop().time() >= deadline:
                raise
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, TEMPORAL_CONNECT_MAX_BACKOFF_SECONDS)


__all__ = ["connect_worker_client"]
