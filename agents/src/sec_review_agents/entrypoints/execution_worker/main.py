"""Run the Temporal worker for review execution."""

import asyncio
from concurrent.futures import ThreadPoolExecutor

from temporalio.worker import Worker

from sec_review_agents.entrypoints.execution_worker.workflows import (
    ACTIVITIES,
    WORKFLOWS,
)
from sec_review_agents.temporal.config import (
    DEFAULT_EXECUTION_TASK_QUEUE,
)
from sec_review_agents.temporal.worker_runtime import connect_worker_client
from sec_review_agents.utils.env import env_value, int_env

DEFAULT_MAX_CONCURRENT_ACTIVITIES = 2


async def run_worker() -> None:
    task_queue = (
        env_value("TEMPORAL_EXECUTION_TASK_QUEUE") or DEFAULT_EXECUTION_TASK_QUEUE
    )
    max_concurrent_activities = int_env(
        "TEMPORAL_EXECUTION_MAX_CONCURRENT_ACTIVITIES",
        DEFAULT_MAX_CONCURRENT_ACTIVITIES,
        minimum=1,
    )
    client = await connect_worker_client()
    with ThreadPoolExecutor(max_workers=max_concurrent_activities) as executor:
        worker = Worker(
            client,
            task_queue=task_queue,
            workflows=WORKFLOWS,
            activities=ACTIVITIES,
            activity_executor=executor,
            max_concurrent_activities=max_concurrent_activities,
        )
        await worker.run()


def main() -> None:
    asyncio.run(run_worker())


__all__ = [
    "main",
    "run_worker",
]
