"""Run the Temporal worker for asynchronous memory processing."""

import asyncio
from concurrent.futures import ThreadPoolExecutor

from temporalio.worker import Worker

from sec_review_agents.entrypoints.memory_worker.workflows import ACTIVITIES, WORKFLOWS
from sec_review_agents.memory.schedule import ensure_configured_memory_schedules
from sec_review_agents.temporal.config import DEFAULT_MEMORY_TASK_QUEUE
from sec_review_agents.temporal.worker_runtime import connect_temporal_client
from sec_review_agents.utils.env import env_value, parse_int_env

DEFAULT_MAX_CONCURRENT_ACTIVITIES = 1


async def run_worker() -> None:
    client = await connect_temporal_client()
    task_queue = DEFAULT_MEMORY_TASK_QUEUE
    await ensure_configured_memory_schedules(client, task_queue=task_queue)
    max_concurrent_activities = max(
        1,
        parse_int_env(
            env_value("TEMPORAL_MEMORY_MAX_CONCURRENT_ACTIVITIES"),
            DEFAULT_MAX_CONCURRENT_ACTIVITIES,
        )
        or DEFAULT_MAX_CONCURRENT_ACTIVITIES,
    )
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


__all__ = ["main", "run_worker"]
