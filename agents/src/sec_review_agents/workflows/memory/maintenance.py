from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal

from temporalio import activity, workflow

from sec_review_agents.memory.revision_creation import MemoryTreeRevisionCreation
from sec_review_agents.temporal.support import activity_retry_policy

MEMORY_MAINTENANCE_PENDING_THRESHOLD = 10
MEMORY_MAINTENANCE_PENDING_MAX_AGE = timedelta(days=1)
MEMORY_MAINTENANCE_DEFAULT_BATCH_SIZE = 10
# Manual and scheduled starts share this ID. Temporal rejects another start while
# that workflow is running; the schedule also skips overlapping triggers.
MEMORY_MAINTENANCE_WORKFLOW_ID = "memory-maintenance"


@dataclass(frozen=True)
class MemoryMaintenanceRequest:
    timeout_seconds: int
    batch_size: int = MEMORY_MAINTENANCE_DEFAULT_BATCH_SIZE
    require_threshold: bool = False


@dataclass(frozen=True)
class MemoryMaintenancePreparationResult:
    kind: Literal["complete", "prepared"]
    revision_creation: MemoryTreeRevisionCreation | None = None
    reason: str | None = None
    summary: str | None = None

    def __post_init__(self) -> None:
        if self.kind == "complete":
            has_reason = (
                isinstance(self.reason, str)
                and bool(self.reason.strip())
                and self.summary is None
            )
            has_summary = (
                self.reason is None
                and isinstance(self.summary, str)
                and bool(self.summary.strip())
            )
            if self.revision_creation is not None or not (has_reason or has_summary):
                raise ValueError(
                    "Completed maintenance preparation requires exactly one non-empty "
                    "reason or summary, with the other field unset."
                )
            return
        if self.kind == "prepared":
            if (
                not isinstance(self.revision_creation, MemoryTreeRevisionCreation)
                or self.reason is not None
                or self.summary is not None
            ):
                raise ValueError(
                    "Prepared maintenance requires only a revision creation."
                )
            return
        raise ValueError(f"Unsupported maintenance preparation kind: {self.kind!r}")


@activity.defn
async def prepare_memory_maintenance_activity(
    request: MemoryMaintenanceRequest,
) -> MemoryMaintenancePreparationResult:
    from sec_review_agents.features import memory_processing_enabled
    from sec_review_agents.memory.catalog_client import configured_memory_catalog_client
    from sec_review_agents.memory.coordinated_maintenance import (
        prepare_coordinated_memory_revision,
    )
    from sec_review_agents.utils.env import bootstrap_agents_env

    bootstrap_agents_env()
    if request.batch_size < 1:
        raise ValueError("Memory maintenance batch_size must be positive.")
    if not memory_processing_enabled():
        return MemoryMaintenancePreparationResult(
            kind="complete",
            reason="AGENT_MEMORY_PROCESSING_ENABLED is false.",
        )
    catalog_client = configured_memory_catalog_client()
    if catalog_client is None:
        raise ValueError("AGENT_MEMORY_CATALOG_URL is required for memory maintenance.")
    if catalog_client.get_maintenance_control().get("state") == "paused":
        return MemoryMaintenancePreparationResult(
            kind="complete",
            summary="Automatic memory maintenance is paused.",
        )
    revision_creation = await prepare_coordinated_memory_revision(
        catalog_client=catalog_client,
        maintenance_id=f"maintenance-{activity.info().workflow_run_id}",
        deployment=None,
        batch_size=request.batch_size,
    )
    if revision_creation is None:
        return MemoryMaintenancePreparationResult(
            kind="complete",
            summary="No pending memory observations selected.",
        )
    return MemoryMaintenancePreparationResult(
        kind="prepared",
        revision_creation=revision_creation,
    )


@activity.defn
def commit_memory_tree_revision_activity(
    creation: MemoryTreeRevisionCreation,
) -> dict[str, Any]:
    from temporalio.exceptions import ApplicationError

    from sec_review_agents.memory.catalog_client import (
        MemoryCatalogConflictError,
        MemoryMaintenancePausedError,
        configured_memory_catalog_client,
    )
    from sec_review_agents.utils.env import bootstrap_agents_env

    bootstrap_agents_env()
    catalog_client = configured_memory_catalog_client()
    if catalog_client is None:
        raise RuntimeError(
            "Memory catalog is required to commit a coordinated revision."
        )
    try:
        committed = catalog_client.create_memory_tree_revision(
            maintenance_id=creation.maintenance_id,
            expected_active_revision=creation.expected_active_revision,
            extraction_ids=list(creation.extraction_ids),
            memory_tree_reference=creation.memory_tree_reference,
            maintenance_trajectory_reference=creation.maintenance_trajectory_reference,
        )
    except MemoryMaintenancePausedError as error:
        raise ApplicationError(
            str(error),
            type="MEMORY_MAINTENANCE_PAUSED",
            non_retryable=True,
        ) from error
    except MemoryCatalogConflictError as error:
        raise ApplicationError(
            str(error),
            type="MEMORY_CATALOG_REVISION_CONFLICT",
            non_retryable=True,
        ) from error
    source = committed.get("source")
    if (
        not isinstance(source, dict)
        or source.get("kind") != "maintenance"
        or source.get("maintenance_id") != creation.maintenance_id
    ):
        raise RuntimeError("Catalog returned a different maintenance identity.")
    return {
        "ok": True,
        "skipped": False,
        "summary": f"Processed {len(creation.extraction_ids)} memory observations.",
        "processed_count": len(creation.extraction_ids),
    }


@activity.defn
def count_pending_memory_observations_activity() -> dict[str, Any]:
    from sec_review_agents.features import memory_processing_enabled
    from sec_review_agents.memory.catalog_client import (
        configured_memory_catalog_client,
    )
    from sec_review_agents.utils.env import bootstrap_agents_env

    bootstrap_agents_env()
    if not memory_processing_enabled():
        return {
            "ok": True,
            "skipped": True,
            "reason": "AGENT_MEMORY_PROCESSING_ENABLED is false.",
            "pending_count": 0,
            "oldest_pending_created_at": None,
        }
    catalog_client = configured_memory_catalog_client()
    if catalog_client is None:
        raise ValueError("AGENT_MEMORY_CATALOG_URL is required for memory maintenance.")
    return {
        "ok": True,
        "skipped": False,
        **catalog_client.get_observation_backlog(),
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
        result: dict[str, Any]
        if prepared.kind == "complete":
            result = {
                "ok": True,
                "skipped": True,
                "processed_count": 0,
            }
            if prepared.reason is not None:
                result["reason"] = prepared.reason
            else:
                assert prepared.summary is not None
                result["summary"] = prepared.summary
        elif prepared.kind == "prepared":
            assert prepared.revision_creation is not None
            result = await workflow.execute_activity(
                commit_memory_tree_revision_activity,
                prepared.revision_creation,
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
    "MemoryMaintenancePreparationResult",
    "MemoryMaintenanceRequest",
    "MemoryMaintenanceWorkflow",
    "commit_memory_tree_revision_activity",
    "count_pending_memory_observations_activity",
    "prepare_memory_maintenance_activity",
]
