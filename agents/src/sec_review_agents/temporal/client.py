"""Python Temporal connections with the payload protocol required by our models."""

from temporalio.client import Client
from temporalio.contrib.pydantic import pydantic_data_converter


async def connect_temporal_client(*, address: str, namespace: str) -> Client:
    """Connect once; callers own configuration precedence and startup retries.

    The converter is part of the workflow payload protocol: activities and child
    workflows must restore nested Pydantic models, not plain dictionaries. Keep
    it fixed here so CLI submissions and workers cannot silently diverge.
    """
    return await Client.connect(
        address, namespace=namespace, data_converter=pydantic_data_converter
    )
