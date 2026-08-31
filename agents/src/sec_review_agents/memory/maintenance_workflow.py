from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from temporalio import activity, workflow
from temporalio.exceptions import WorkflowAlreadyStartedError

from sec_review_agents.temporal.support import activity_retry_policy

MEMORY_MAINTENANCE_PENDING_THRESHOLD = 10
MEMORY_MAINTENANCE_PENDING_MAX_AGE = timedelta(days=1)
MEMORY_MAINTENANCE_DEFAULT_BATCH_SIZE = 10
MEMORY_MAINTENANCE_THRESHOLD_WORKFLOW_ID = "memory-maintenance-threshold"


@dataclass(frozen=True)
class MemoryMaintenanceTriggerRequest:
    timeout_seconds: int


@dataclass(frozen=True)
class MemoryMaintenanceRequest:
    timeout_seconds: int
    batch_size: int = MEMORY_MAINTENANCE_DEFAULT_BATCH_SIZE


def memory_maintenance_request_for_threshold_trigger(
    *,
    timeout_seconds: int,
) -> MemoryMaintenanceRequest:
    return MemoryMaintenanceRequest(
        timeout_seconds=timeout_seconds,
        batch_size=MEMORY_MAINTENANCE_DEFAULT_BATCH_SIZE,
    )


@activity.defn
async def run_memory_maintenance_activity(
    request: MemoryMaintenanceRequest,
) -> dict[str, Any]:
    from sec_review_agents.features import agent_memory_enabled
    from sec_review_agents.memory.maintainer import maintain_memory_with_result
    from sec_review_agents.memory.store import resolve_memory_store_dir
    from sec_review_agents.utils.env import bootstrap_agents_env

    bootstrap_agents_env()
    memory_store_dir = resolve_memory_store_dir(None, required=False)
    if memory_store_dir is None:
        return {
            "ok": True,
            "skipped": True,
            "reason": (
                "AGENT_MEMORY_ENABLED is false."
                if not agent_memory_enabled()
                else "AGENT_MEMORY_DIR is not configured."
            ),
        }

    if request.batch_size < 1:
        raise ValueError("Memory maintenance batch_size must be positive.")

    result = await maintain_memory_with_result(
        memory_store_dir=memory_store_dir,
        deployment=None,
        batch_size=request.batch_size,
    )
    return {
        "ok": True,
        "skipped": result.skipped,
        "summary": result.summary,
        "processed_count": result.processed_count,
        "memory_store_dir": str(memory_store_dir),
    }


@activity.defn
def count_pending_memory_observations_activity() -> dict[str, Any]:
    from sec_review_agents.features import agent_memory_enabled
    from sec_review_agents.memory.state import (
        OBSERVATION_STATUS_PENDING,
        count_observations_by_status,
        initialize_memory_state,
        oldest_observation_created_at_by_status,
        open_memory_state,
    )
    from sec_review_agents.memory.store import resolve_memory_store_dir
    from sec_review_agents.utils.env import bootstrap_agents_env

    bootstrap_agents_env()
    memory_store_dir = resolve_memory_store_dir(None, required=False)
    if memory_store_dir is None:
        return {
            "ok": True,
            "skipped": True,
            "pending_count": 0,
            "reason": (
                "AGENT_MEMORY_ENABLED is false."
                if not agent_memory_enabled()
                else "AGENT_MEMORY_DIR is not configured."
            ),
        }

    # Count probes need only the ledger; avoid creating Markdown memory files here.
    initialize_memory_state(memory_store_dir)
    with open_memory_state(memory_store_dir) as connection:
        pending_count = count_observations_by_status(
            connection,
            status=OBSERVATION_STATUS_PENDING,
        )
        oldest_pending_created_at = oldest_observation_created_at_by_status(
            connection,
            status=OBSERVATION_STATUS_PENDING,
        )
    return {
        "ok": True,
        "skipped": False,
        "pending_count": pending_count,
        "oldest_pending_created_at": oldest_pending_created_at,
        "memory_store_dir": str(memory_store_dir),
    }


def _pending_age_exceeds_threshold(
    *,
    oldest_pending_created_at: str | None,
    now: datetime,
) -> bool:
    if oldest_pending_created_at is None:
        return False
    created_at = datetime.fromisoformat(oldest_pending_created_at)
    return now - created_at >= MEMORY_MAINTENANCE_PENDING_MAX_AGE


async def maybe_start_memory_maintenance_for_pending_observations(
    trigger_request: MemoryMaintenanceTriggerRequest,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    try:
        count_result = await workflow.execute_activity(
            count_pending_memory_observations_activity,
            schedule_to_close_timeout=timedelta(
                seconds=trigger_request.timeout_seconds
            ),
            retry_policy=activity_retry_policy(),
        )
        pending_count = int(count_result.get("pending_count") or 0)
        oldest_pending_created_at = count_result.get("oldest_pending_created_at")
        if not isinstance(oldest_pending_created_at, str):
            oldest_pending_created_at = None
        should_start_for_count = pending_count >= MEMORY_MAINTENANCE_PENDING_THRESHOLD
        should_start_for_age = _pending_age_exceeds_threshold(
            oldest_pending_created_at=oldest_pending_created_at,
            now=now or workflow.now(),
        )
        if not should_start_for_count and not should_start_for_age:
            return {
                "ok": True,
                "started": False,
                "reason": "below_threshold",
                "pending_count": pending_count,
                "oldest_pending_created_at": oldest_pending_created_at,
            }
        await workflow.start_child_workflow(
            MemoryMaintenanceWorkflow.run,
            memory_maintenance_request_for_threshold_trigger(
                timeout_seconds=trigger_request.timeout_seconds
            ),
            id=MEMORY_MAINTENANCE_THRESHOLD_WORKFLOW_ID,
            parent_close_policy=workflow.ParentClosePolicy.ABANDON,
        )
        return {
            "ok": True,
            "started": True,
            "pending_count": pending_count,
            "reason": "pending_threshold" if should_start_for_count else "pending_age",
            "oldest_pending_created_at": oldest_pending_created_at,
        }
    except WorkflowAlreadyStartedError:
        workflow.logger.info(
            "Memory maintenance workflow for pending observations already running"
        )
        return {
            "ok": True,
            "started": False,
            "reason": "already_running",
        }
    except Exception as error:
        workflow.logger.warning(
            "Failed to start memory maintenance for pending observations: %s",
            error,
        )
        return {
            "ok": False,
            "started": False,
            "reason": "start_failed",
            "error": str(error),
        }


@workflow.defn
class MemoryMaintenanceTriggerWorkflow:
    @workflow.run
    async def run(self, request: MemoryMaintenanceTriggerRequest) -> dict[str, Any]:
        return await maybe_start_memory_maintenance_for_pending_observations(request)


@workflow.defn
class MemoryMaintenanceWorkflow:
    @workflow.run
    async def run(self, request: MemoryMaintenanceRequest) -> dict[str, Any]:
        if request.batch_size < 1:
            raise ValueError("Memory maintenance batch_size must be positive.")
        result = await workflow.execute_activity(
            run_memory_maintenance_activity,
            request,
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )

        count_result = await workflow.execute_activity(
            count_pending_memory_observations_activity,
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        if (
            int(count_result.get("pending_count") or 0)
            >= MEMORY_MAINTENANCE_PENDING_THRESHOLD
        ):
            workflow.continue_as_new(request)
        return result


__all__ = [
    "MEMORY_MAINTENANCE_DEFAULT_BATCH_SIZE",
    "MEMORY_MAINTENANCE_PENDING_MAX_AGE",
    "MEMORY_MAINTENANCE_PENDING_THRESHOLD",
    "MEMORY_MAINTENANCE_THRESHOLD_WORKFLOW_ID",
    "MemoryMaintenanceRequest",
    "MemoryMaintenanceTriggerRequest",
    "MemoryMaintenanceTriggerWorkflow",
    "MemoryMaintenanceWorkflow",
    "count_pending_memory_observations_activity",
    "maybe_start_memory_maintenance_for_pending_observations",
    "memory_maintenance_request_for_threshold_trigger",
    "run_memory_maintenance_activity",
]
