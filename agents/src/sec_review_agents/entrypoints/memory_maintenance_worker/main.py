"""Run the singleton Temporal worker for memory-tree maintenance."""

import asyncio
from concurrent.futures import ThreadPoolExecutor

from temporalio.worker import Worker

from sec_review_agents.entrypoints.memory_maintenance_worker.schedules import (
    ensure_configured_memory_schedules,
)
from sec_review_agents.entrypoints.memory_maintenance_worker.workflows import (
    ACTIVITIES,
    WORKFLOWS,
)
from sec_review_agents.temporal.config import DEFAULT_MEMORY_MAINTENANCE_TASK_QUEUE
from sec_review_agents.temporal.worker_runtime import connect_worker_client
from sec_review_agents.utils.env import int_env

MAX_CONCURRENT_ACTIVITIES = 1


async def run_worker() -> None:
    max_concurrent_activities = int_env(
        "TEMPORAL_MEMORY_MAINTENANCE_MAX_CONCURRENT_ACTIVITIES",
        MAX_CONCURRENT_ACTIVITIES,
        minimum=1,
        maximum=MAX_CONCURRENT_ACTIVITIES,
    )
    client = await connect_worker_client()
    await ensure_configured_memory_schedules(
        client,
        task_queue=DEFAULT_MEMORY_MAINTENANCE_TASK_QUEUE,
    )
    with ThreadPoolExecutor(max_workers=max_concurrent_activities) as executor:
        worker = Worker(
            client,
            task_queue=DEFAULT_MEMORY_MAINTENANCE_TASK_QUEUE,
            workflows=WORKFLOWS,
            activities=ACTIVITIES,
            activity_executor=executor,
            max_concurrent_activities=max_concurrent_activities,
        )
        await worker.run()


def main() -> None:
    asyncio.run(run_worker())


__all__ = ["main", "run_worker"]
