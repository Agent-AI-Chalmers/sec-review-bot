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

from sec_review_agents.memory.extraction_workflow import (
    MemoryExtractionRunRequest,
    MemoryExtractionWorkflow,
)
from sec_review_agents.memory.maintenance_workflow import (
    MemoryMaintenanceTriggerRequest,
    MemoryMaintenanceTriggerWorkflow,
)
from sec_review_agents.memory.store import initialize_configured_memory_store
from sec_review_agents.observability.log_config import logger
from sec_review_agents.runner.temporal_config import (
    DEFAULT_TEMPORAL_TASK_QUEUE,
    DEFAULT_WORKFLOW_TIMEOUT_SECONDS,
)
from sec_review_agents.utils.env import env_value, parse_int_env

MEMORY_EXTRACTION_SCHEDULE_ID = "memory-extraction-batch"
MEMORY_EXTRACTION_WORKFLOW_ID = "memory-extraction-batch"
MEMORY_EXTRACTION_SCHEDULE_DEFAULT_INTERVAL_SECONDS = 10 * 60
MEMORY_MAINTENANCE_SCHEDULE_ID = "memory-maintenance-pending-trigger"
MEMORY_MAINTENANCE_TRIGGER_WORKFLOW_ID = "memory-maintenance-pending-trigger"
MEMORY_MAINTENANCE_SCHEDULE_DEFAULT_INTERVAL_SECONDS = 60 * 60


@dataclass(frozen=True)
class MemoryMaintenanceScheduleRequest:
    timeout_seconds: int
    interval_seconds: int = MEMORY_MAINTENANCE_SCHEDULE_DEFAULT_INTERVAL_SECONDS
    schedule_id: str = MEMORY_MAINTENANCE_SCHEDULE_ID
    workflow_id: str = MEMORY_MAINTENANCE_TRIGGER_WORKFLOW_ID
    task_queue: str = DEFAULT_TEMPORAL_TASK_QUEUE
    trigger_immediately: bool = False


@dataclass(frozen=True)
class MemoryExtractionScheduleRequest:
    timeout_seconds: int
    interval_seconds: int = MEMORY_EXTRACTION_SCHEDULE_DEFAULT_INTERVAL_SECONDS
    schedule_id: str = MEMORY_EXTRACTION_SCHEDULE_ID
    workflow_id: str = MEMORY_EXTRACTION_WORKFLOW_ID
    task_queue: str = DEFAULT_TEMPORAL_TASK_QUEUE
    trigger_immediately: bool = False


def build_memory_extraction_schedule(
    request: MemoryExtractionScheduleRequest,
) -> Schedule:
    if request.timeout_seconds < 1:
        raise ValueError("timeout_seconds must be positive.")
    if request.interval_seconds < 1:
        raise ValueError("interval_seconds must be positive.")
    return Schedule(
        action=ScheduleActionStartWorkflow(
            MemoryExtractionWorkflow.run,
            MemoryExtractionRunRequest(
                timeout_seconds=request.timeout_seconds,
            ),
            id=request.workflow_id,
            task_queue=request.task_queue,
        ),
        spec=ScheduleSpec(
            intervals=[
                ScheduleIntervalSpec(every=timedelta(seconds=request.interval_seconds))
            ],
        ),
        policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP),
        state=ScheduleState(
            note="Periodically processes pending memory extraction jobs.",
        ),
    )


def build_memory_maintenance_schedule(
    request: MemoryMaintenanceScheduleRequest,
) -> Schedule:
    if request.timeout_seconds < 1:
        raise ValueError("timeout_seconds must be positive.")
    if request.interval_seconds < 1:
        raise ValueError("interval_seconds must be positive.")
    return Schedule(
        action=ScheduleActionStartWorkflow(
            MemoryMaintenanceTriggerWorkflow.run,
            MemoryMaintenanceTriggerRequest(
                timeout_seconds=request.timeout_seconds,
            ),
            id=request.workflow_id,
            task_queue=request.task_queue,
        ),
        spec=ScheduleSpec(
            intervals=[
                ScheduleIntervalSpec(every=timedelta(seconds=request.interval_seconds))
            ],
        ),
        policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP),
        state=ScheduleState(
            note=(
                "Periodically checks pending memory observations and starts "
                "maintenance when they reach the threshold."
            ),
        ),
    )


async def ensure_memory_extraction_schedule(
    client: Client,
    request: MemoryExtractionScheduleRequest,
) -> dict[str, object]:
    schedule = build_memory_extraction_schedule(request)
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
        "workflow_id": request.workflow_id,
        "interval_seconds": request.interval_seconds,
        "trigger_immediately": request.trigger_immediately,
    }


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
        "workflow_id": request.workflow_id,
        "interval_seconds": request.interval_seconds,
        "trigger_immediately": request.trigger_immediately,
    }


def _workflow_timeout_seconds() -> int:
    return (
        parse_int_env(
            env_value("TEMPORAL_WORKFLOW_TIMEOUT_SECONDS"),
            DEFAULT_WORKFLOW_TIMEOUT_SECONDS,
        )
        or DEFAULT_WORKFLOW_TIMEOUT_SECONDS
    )


async def ensure_default_memory_extraction_schedule(
    client: Client,
    *,
    task_queue: str,
) -> dict[str, object]:
    return await ensure_memory_extraction_schedule(
        client,
        MemoryExtractionScheduleRequest(
            timeout_seconds=_workflow_timeout_seconds(),
            task_queue=task_queue,
        ),
    )


async def ensure_default_memory_maintenance_schedule(
    client: Client,
    *,
    task_queue: str,
) -> dict[str, object]:
    return await ensure_memory_maintenance_schedule(
        client,
        MemoryMaintenanceScheduleRequest(
            timeout_seconds=_workflow_timeout_seconds(),
            task_queue=task_queue,
        ),
    )


async def ensure_configured_memory_maintenance_schedule(
    client: Client,
    *,
    task_queue: str,
) -> None:
    memory_store_dir = initialize_configured_memory_store()
    if memory_store_dir is None:
        return
    try:
        result = await ensure_default_memory_maintenance_schedule(
            client,
            task_queue=task_queue,
        )
    except Exception as error:
        logger.warning(
            "memory_maintenance_schedule_ensure_failed",
            error=str(error),
        )
        return
    logger.info(
        "memory_maintenance_schedule_ensured",
        action=result.get("action"),
        schedule_id=result.get("schedule_id"),
        interval_seconds=result.get("interval_seconds"),
    )


async def ensure_configured_memory_schedules(
    client: Client,
    *,
    task_queue: str,
) -> None:
    memory_store_dir = initialize_configured_memory_store()
    if memory_store_dir is None:
        return
    for label, ensure_default_schedule in [
        ("extraction", ensure_default_memory_extraction_schedule),
        ("maintenance", ensure_default_memory_maintenance_schedule),
    ]:
        try:
            result = await ensure_default_schedule(
                client,
                task_queue=task_queue,
            )
        except Exception as error:
            logger.warning(
                "memory_schedule_ensure_failed",
                schedule=label,
                error=str(error),
            )
            continue
        logger.info(
            "memory_schedule_ensured",
            schedule=label,
            action=result.get("action"),
            schedule_id=result.get("schedule_id"),
            interval_seconds=result.get("interval_seconds"),
        )


__all__ = [
    "MEMORY_EXTRACTION_SCHEDULE_DEFAULT_INTERVAL_SECONDS",
    "MEMORY_EXTRACTION_SCHEDULE_ID",
    "MEMORY_EXTRACTION_WORKFLOW_ID",
    "MEMORY_MAINTENANCE_SCHEDULE_DEFAULT_INTERVAL_SECONDS",
    "MEMORY_MAINTENANCE_SCHEDULE_ID",
    "MEMORY_MAINTENANCE_TRIGGER_WORKFLOW_ID",
    "MemoryExtractionScheduleRequest",
    "MemoryMaintenanceScheduleRequest",
    "build_memory_extraction_schedule",
    "build_memory_maintenance_schedule",
    "ensure_configured_memory_maintenance_schedule",
    "ensure_configured_memory_schedules",
    "ensure_default_memory_extraction_schedule",
    "ensure_default_memory_maintenance_schedule",
    "ensure_memory_extraction_schedule",
    "ensure_memory_maintenance_schedule",
]
