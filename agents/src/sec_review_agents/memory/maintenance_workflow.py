from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from temporalio import activity, workflow

from sec_review_agents.temporal.support import activity_retry_policy

MEMORY_MAINTENANCE_PENDING_THRESHOLD = 10
MEMORY_MAINTENANCE_PENDING_MAX_AGE = timedelta(days=1)
MEMORY_MAINTENANCE_DEFAULT_BATCH_SIZE = 10
MEMORY_MAINTENANCE_WORKFLOW_ID = "memory-maintenance"


@dataclass(frozen=True)
class MemoryMaintenanceRequest:
    timeout_seconds: int
    batch_size: int = MEMORY_MAINTENANCE_DEFAULT_BATCH_SIZE
    require_threshold: bool = False


@activity.defn
async def run_memory_maintenance_activity(
    request: MemoryMaintenanceRequest,
) -> dict[str, Any]:
    from sec_review_agents.features import agent_memory_enabled
    from sec_review_agents.memory.catalog_client import (
        configured_memory_catalog_client,
    )
    from sec_review_agents.memory.maintainer import (
        maintain_managed_memory_with_result,
        maintain_memory_with_result,
    )
    from sec_review_agents.memory.store import resolve_memory_store_dir
    from sec_review_agents.utils.env import bootstrap_agents_env

    bootstrap_agents_env()
    catalog_client = configured_memory_catalog_client()
    if request.batch_size < 1:
        raise ValueError("Memory maintenance batch_size must be positive.")
    if catalog_client is not None:
        result = await maintain_managed_memory_with_result(
            catalog_client=catalog_client,
            deployment=None,
            batch_size=request.batch_size,
        )
        return {
            "ok": True,
            "skipped": result.skipped,
            "summary": result.summary,
            "processed_count": result.processed_count,
            "memory_store_dir": None,
        }
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
    from sec_review_agents.memory.catalog_client import (
        configured_memory_catalog_client,
    )
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
    catalog_client = configured_memory_catalog_client()
    if catalog_client is not None:
        return {
            "ok": True,
            "skipped": False,
            **catalog_client.pending_observation_summary(),
            "memory_store_dir": None,
        }
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
    return now - datetime.fromisoformat(oldest_pending_created_at) >= (
        MEMORY_MAINTENANCE_PENDING_MAX_AGE
    )


async def _pending_summary(request: MemoryMaintenanceRequest) -> dict[str, Any]:
    return await workflow.execute_activity(
        count_pending_memory_observations_activity,
        schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
        retry_policy=activity_retry_policy(),
    )


def _threshold_reached(summary: dict[str, Any], *, now: datetime) -> bool:
    oldest = summary.get("oldest_pending_created_at")
    return int(summary.get("pending_count") or 0) >= (
        MEMORY_MAINTENANCE_PENDING_THRESHOLD
    ) or _pending_age_exceeds_threshold(
        oldest_pending_created_at=oldest if isinstance(oldest, str) else None,
        now=now,
    )


@workflow.defn
class MemoryMaintenanceWorkflow:
    @workflow.run
    async def run(self, request: MemoryMaintenanceRequest) -> dict[str, Any]:
        if request.batch_size < 1:
            raise ValueError("Memory maintenance batch_size must be positive.")
        before = await _pending_summary(request)
        if request.require_threshold and not _threshold_reached(
            before,
            now=workflow.now(),
        ):
            return {
                **before,
                "ok": True,
                "skipped": True,
                "reason": "below_threshold",
            }

        result = await workflow.execute_activity(
            run_memory_maintenance_activity,
            request,
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        after = await _pending_summary(request)
        if int(after.get("pending_count") or 0) >= (
            MEMORY_MAINTENANCE_PENDING_THRESHOLD
        ):
            workflow.continue_as_new(request)
        return result


__all__ = [
    "MEMORY_MAINTENANCE_DEFAULT_BATCH_SIZE",
    "MEMORY_MAINTENANCE_PENDING_MAX_AGE",
    "MEMORY_MAINTENANCE_PENDING_THRESHOLD",
    "MEMORY_MAINTENANCE_WORKFLOW_ID",
    "MemoryMaintenanceRequest",
    "MemoryMaintenanceWorkflow",
    "count_pending_memory_observations_activity",
    "run_memory_maintenance_activity",
]
