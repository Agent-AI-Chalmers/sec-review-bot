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
async def prepare_memory_maintenance_activity(
    request: MemoryMaintenanceRequest,
) -> dict[str, Any]:
    from sec_review_agents.features import memory_processing_enabled
    from sec_review_agents.memory.catalog_client import configured_memory_catalog_client
    from sec_review_agents.memory.coordinated_maintenance import (
        prepare_coordinated_memory_revision,
    )
    from sec_review_agents.memory.local_store import resolve_memory_store_dir
    from sec_review_agents.memory.maintainer import (
        maintain_memory_with_result,
    )
    from sec_review_agents.utils.env import bootstrap_agents_env

    bootstrap_agents_env()
    catalog_client = configured_memory_catalog_client()
    if request.batch_size < 1:
        raise ValueError("Memory maintenance batch_size must be positive.")
    if catalog_client is not None:
        revision = await prepare_coordinated_memory_revision(
            catalog_client=catalog_client,
            maintenance_id=f"maintenance-{activity.info().workflow_run_id}",
            deployment=None,
            batch_size=request.batch_size,
        )
        if revision is None:
            return {
                "kind": "complete",
                "result": {
                    "ok": True,
                    "skipped": True,
                    "summary": "No pending memory observations selected.",
                    "processed_count": 0,
                    "memory_store_dir": None,
                },
            }
        return {
            "kind": "coordinated_revision",
            "revision": revision,
        }
    memory_store_dir = resolve_memory_store_dir(None, required=False)
    if memory_store_dir is None:
        return {
            "kind": "complete",
            "result": {
                "ok": True,
                "skipped": True,
                "reason": (
                    "AGENT_MEMORY_PROCESSING_ENABLED is false."
                    if not memory_processing_enabled()
                    else "AGENT_MEMORY_DIR is not configured."
                ),
            },
        }

    result = await maintain_memory_with_result(
        memory_store_dir=memory_store_dir,
        deployment=None,
        batch_size=request.batch_size,
    )
    return {
        "kind": "complete",
        "result": {
            "ok": True,
            "skipped": result.skipped,
            "summary": result.summary,
            "processed_count": result.processed_count,
            "memory_store_dir": str(memory_store_dir),
        },
    }


@activity.defn
def commit_memory_tree_revision_activity(
    revision: dict[str, Any],
) -> dict[str, Any]:
    from temporalio.exceptions import ApplicationError

    from sec_review_agents.artifacts.reference import ArtifactReference
    from sec_review_agents.memory.catalog_client import (
        MemoryCatalogConflictError,
        configured_memory_catalog_client,
    )
    from sec_review_agents.utils.env import bootstrap_agents_env

    bootstrap_agents_env()
    catalog_client = configured_memory_catalog_client()
    if catalog_client is None:
        raise RuntimeError(
            "Memory catalog is required to commit a coordinated revision."
        )
    maintenance_id = str(revision["maintenance_id"])
    extraction_ids = revision["extraction_ids"]
    if not isinstance(extraction_ids, list) or not all(
        isinstance(value, str) for value in extraction_ids
    ):
        raise ValueError("Prepared memory revision has invalid extraction identities.")
    try:
        committed = catalog_client.create_memory_tree_revision(
            maintenance_id=maintenance_id,
            base_revision=int(revision["base_revision"]),
            extraction_ids=extraction_ids,
            memory_tree_reference=ArtifactReference.from_mapping(
                revision["memory_tree_reference"]
            ),
            maintenance_transcript_reference=ArtifactReference.from_mapping(
                revision["maintenance_transcript_reference"]
            ),
        )
    except MemoryCatalogConflictError as error:
        raise ApplicationError(
            str(error),
            type="MEMORY_CATALOG_REVISION_CONFLICT",
            non_retryable=True,
        ) from error
    if committed.get("maintenance_id") != maintenance_id:
        raise RuntimeError("Catalog returned a different maintenance identity.")
    return {
        "ok": True,
        "skipped": False,
        "summary": f"Processed {len(extraction_ids)} memory observations.",
        "processed_count": len(extraction_ids),
        "memory_store_dir": None,
    }


@activity.defn
def count_pending_memory_observations_activity() -> dict[str, Any]:
    from sec_review_agents.features import memory_processing_enabled
    from sec_review_agents.memory.catalog_client import (
        configured_memory_catalog_client,
    )
    from sec_review_agents.memory.local_state import (
        OBSERVATION_STATUS_PENDING,
        count_observations_by_status,
        initialize_memory_state,
        oldest_observation_created_at_by_status,
        open_memory_state,
    )
    from sec_review_agents.memory.local_store import resolve_memory_store_dir
    from sec_review_agents.utils.env import bootstrap_agents_env

    bootstrap_agents_env()
    catalog_client = configured_memory_catalog_client()
    if catalog_client is not None:
        return {
            "ok": True,
            "skipped": False,
            **catalog_client.get_observation_backlog(),
            "memory_store_dir": None,
        }
    memory_store_dir = resolve_memory_store_dir(None, required=False)
    if memory_store_dir is None:
        return {
            "ok": True,
            "skipped": True,
            "pending_count": 0,
            "reason": (
                "AGENT_MEMORY_PROCESSING_ENABLED is false."
                if not memory_processing_enabled()
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

        prepared = await workflow.execute_activity(
            prepare_memory_maintenance_activity,
            request,
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        kind = prepared.get("kind")
        if kind == "complete":
            result = prepared["result"]
        elif kind == "coordinated_revision":
            result = await workflow.execute_activity(
                commit_memory_tree_revision_activity,
                prepared["revision"],
                schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
                retry_policy=activity_retry_policy(),
            )
        else:
            raise RuntimeError(
                "Memory maintenance activity returned an invalid result."
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
    "commit_memory_tree_revision_activity",
    "count_pending_memory_observations_activity",
    "prepare_memory_maintenance_activity",
]
