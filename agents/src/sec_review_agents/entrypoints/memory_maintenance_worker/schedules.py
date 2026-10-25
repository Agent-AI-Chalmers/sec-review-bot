from dataclasses import dataclass
from datetime import timedelta

from temporalio.client import (
    Client,
    Schedule,
    ScheduleActionStartWorkflow,
    ScheduleAlreadyRunningError,
    ScheduleIntervalSpec,
    ScheduleOverlapPolicy,
    SchedulePolicy,
    ScheduleSpec,
    ScheduleState,
    ScheduleUpdate,
)
from temporalio.service import RPCError, RPCStatusCode

from sec_review_agents.features import memory_processing_enabled
from sec_review_agents.observability.log_config import logger
from sec_review_agents.temporal.config import (
    DEFAULT_MEMORY_MAINTENANCE_TASK_QUEUE,
    DEFAULT_WORKFLOW_TIMEOUT_SECONDS,
)
from sec_review_agents.utils.env import int_env
from sec_review_agents.workflows.memory.maintenance import (
    MEMORY_MAINTENANCE_WORKFLOW_ID,
    MemoryMaintenanceRequest,
    MemoryMaintenanceWorkflow,
)

MEMORY_MAINTENANCE_SCHEDULE_ID = "memory-maintenance"
MEMORY_MAINTENANCE_SCHEDULE_DEFAULT_INTERVAL_SECONDS = 60 * 60
OBSOLETE_MEMORY_SCHEDULE_IDS = (
    "memory-extraction-batch",
    "memory-maintenance-pending-trigger",
)


@dataclass(frozen=True)
class MemoryMaintenanceScheduleRequest:
    timeout_seconds: int
    interval_seconds: int = MEMORY_MAINTENANCE_SCHEDULE_DEFAULT_INTERVAL_SECONDS
    schedule_id: str = MEMORY_MAINTENANCE_SCHEDULE_ID
    task_queue: str = DEFAULT_MEMORY_MAINTENANCE_TASK_QUEUE
    trigger_immediately: bool = False


def build_memory_maintenance_schedule(
    request: MemoryMaintenanceScheduleRequest,
) -> Schedule:
    if request.timeout_seconds < 1:
        raise ValueError("timeout_seconds must be positive.")
    if request.interval_seconds < 1:
        raise ValueError("interval_seconds must be positive.")
    return Schedule(
        action=ScheduleActionStartWorkflow(
            MemoryMaintenanceWorkflow.run,
            MemoryMaintenanceRequest(
                timeout_seconds=request.timeout_seconds,
                require_threshold=True,
            ),
            id=MEMORY_MAINTENANCE_WORKFLOW_ID,
            task_queue=request.task_queue,
        ),
        spec=ScheduleSpec(
            intervals=[
                ScheduleIntervalSpec(every=timedelta(seconds=request.interval_seconds))
            ],
        ),
        policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP),
        state=ScheduleState(
            note="Periodically maintains observations after a count or age threshold.",
        ),
    )


async def ensure_memory_maintenance_schedule(
    client: Client,
    request: MemoryMaintenanceScheduleRequest,
) -> dict[str, object]:
    schedule = build_memory_maintenance_schedule(request)
    try:
        await client.create_schedule(
            request.schedule_id,
            schedule,
            trigger_immediately=request.trigger_immediately,
        )
        action = "created"
    except ScheduleAlreadyRunningError:
        handle = client.get_schedule_handle(request.schedule_id)

        def update(_input):
            return ScheduleUpdate(schedule=schedule)

        await handle.update(update)
        action = "updated"
        if request.trigger_immediately:
            await handle.trigger(overlap=ScheduleOverlapPolicy.SKIP)
    return {
        "ok": True,
        "action": action,
        "schedule_id": request.schedule_id,
        "workflow_id": MEMORY_MAINTENANCE_WORKFLOW_ID,
        "interval_seconds": request.interval_seconds,
        "trigger_immediately": request.trigger_immediately,
    }


async def ensure_default_memory_maintenance_schedule(
    client: Client,
    *,
    task_queue: str,
) -> dict[str, object]:
    return await ensure_memory_maintenance_schedule(
        client,
        MemoryMaintenanceScheduleRequest(
            timeout_seconds=int_env(
                "TEMPORAL_WORKFLOW_TIMEOUT_SECONDS",
                DEFAULT_WORKFLOW_TIMEOUT_SECONDS,
                minimum=1,
            ),
            task_queue=task_queue,
        ),
    )


async def ensure_configured_memory_schedules(
    client: Client,
    *,
    task_queue: str,
) -> None:
    from sec_review_agents.memory.catalog_client import (
        configured_memory_catalog_client,
    )

    if not memory_processing_enabled():
        for schedule_id in (
            MEMORY_MAINTENANCE_SCHEDULE_ID,
            *OBSOLETE_MEMORY_SCHEDULE_IDS,
        ):
            try:
                await client.get_schedule_handle(schedule_id).delete()
            except RPCError as error:
                if error.status is not RPCStatusCode.NOT_FOUND:
                    raise
            else:
                logger.info(
                    "memory_schedule_deleted",
                    schedule_id=schedule_id,
                    reason="memory_processing_disabled",
                )
        return
    if configured_memory_catalog_client() is None:
        raise ValueError(
            "AGENT_MEMORY_CATALOG_URL is required when memory processing is enabled."
        )
    for schedule_id in OBSOLETE_MEMORY_SCHEDULE_IDS:
        try:
            await client.get_schedule_handle(schedule_id).delete()
        except RPCError as error:
            if error.status is not RPCStatusCode.NOT_FOUND:
                raise
        else:
            logger.info(
                "obsolete_memory_schedule_deleted",
                schedule_id=schedule_id,
            )
    try:
        result = await ensure_default_memory_maintenance_schedule(
            client,
            task_queue=task_queue,
        )
    except Exception as error:
        logger.warning(
            "memory_schedule_ensure_failed",
            schedule="maintenance",
            error=str(error),
        )
        return
    logger.info(
        "memory_schedule_ensured",
        schedule="maintenance",
        action=result.get("action"),
        schedule_id=result.get("schedule_id"),
        interval_seconds=result.get("interval_seconds"),
    )


__all__ = [
    "MEMORY_MAINTENANCE_SCHEDULE_DEFAULT_INTERVAL_SECONDS",
    "MEMORY_MAINTENANCE_SCHEDULE_ID",
    "OBSOLETE_MEMORY_SCHEDULE_IDS",
    "MemoryMaintenanceScheduleRequest",
    "build_memory_maintenance_schedule",
    "ensure_configured_memory_schedules",
    "ensure_default_memory_maintenance_schedule",
    "ensure_memory_maintenance_schedule",
]
