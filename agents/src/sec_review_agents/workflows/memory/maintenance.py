from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal

from temporalio import activity, workflow

from sec_review_agents.memory.revision_commit_input import (
    MemoryTreeRevisionCommitInput,
)
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
    mode: Literal["learning", "reorganization"] = "learning"

    def __post_init__(self) -> None:
        if self.mode not in {"learning", "reorganization"}:
            raise ValueError("Memory maintenance mode is invalid.")
        if self.mode == "reorganization" and self.require_threshold:
            raise ValueError(
                "Memory reorganization cannot require an observation threshold."
            )


@dataclass(frozen=True)
class MemoryMaintenancePreparationResult:
    kind: Literal["complete", "prepared"]
    commit_input: MemoryTreeRevisionCommitInput | None = None
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
            if self.commit_input is not None or not (has_reason or has_summary):
                raise ValueError(
                    "Completed maintenance preparation requires exactly one non-empty "
                    "reason or summary, with the other field unset."
                )
            return
        if self.kind == "prepared":
            if (
                not isinstance(self.commit_input, MemoryTreeRevisionCommitInput)
                or self.reason is not None
                or self.summary is not None
            ):
                raise ValueError(
                    "Prepared maintenance requires only a revision commit input."
                )
            return
        raise ValueError(f"Unsupported maintenance preparation kind: {self.kind!r}")


@activity.defn
async def prepare_memory_maintenance_activity(
    request: MemoryMaintenanceRequest,
) -> MemoryMaintenancePreparationResult:
    from sec_review_agents.features import memory_processing_enabled
    from sec_review_agents.memory.catalog_client import (
        MemoryPublicationAbandonedError,
        configured_memory_catalog_client,
    )
    from sec_review_agents.memory.coordinated_maintenance import (
        prepare_coordinated_memory_learning,
        prepare_coordinated_memory_reorganization,
    )

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
    operation_id = f"memory-tree-{activity.info().workflow_run_id}"
    if catalog_client.get_memory_tree_automation().get("state") == "paused":
        catalog_client.abandon_revision_publications(operation_id, kind=request.mode)
        return MemoryMaintenancePreparationResult(
            kind="complete",
            reason="automation_paused",
        )
    try:
        if request.mode == "reorganization":
            reorganized = await prepare_coordinated_memory_reorganization(
                catalog_client=catalog_client,
                operation_id=operation_id,
                deployment=None,
            )
            if reorganized.commit_input is None:
                return MemoryMaintenancePreparationResult(
                    kind="complete",
                    summary=reorganized.summary,
                )
            return MemoryMaintenancePreparationResult(
                kind="prepared",
                commit_input=reorganized.commit_input,
            )
        commit_input = await prepare_coordinated_memory_learning(
            catalog_client=catalog_client,
            operation_id=operation_id,
            deployment=None,
            batch_size=request.batch_size,
        )
        if commit_input is None:
            return MemoryMaintenancePreparationResult(
                kind="complete",
                summary="No pending memory observations selected.",
            )
        return MemoryMaintenancePreparationResult(
            kind="prepared",
            commit_input=commit_input,
        )
    except MemoryPublicationAbandonedError:
        return MemoryMaintenancePreparationResult(
            kind="complete", reason="publication_abandoned"
        )


@activity.defn
def commit_memory_tree_revision_activity(
    commit_input: MemoryTreeRevisionCommitInput,
) -> dict[str, Any]:
    from temporalio.exceptions import ApplicationError

    from sec_review_agents.memory.catalog_client import (
        MemoryAutomationPausedError,
        MemoryCatalogConflictError,
        MemoryPublicationAbandonedError,
        configured_memory_catalog_client,
    )

    catalog_client = configured_memory_catalog_client()
    if catalog_client is None:
        raise RuntimeError(
            "Memory catalog is required to commit a coordinated revision."
        )
    try:
        if commit_input.source_kind == "reorganization":
            committed = catalog_client.create_reorganization_revision(
                operation_id=commit_input.operation_id,
                expected_active_revision=commit_input.expected_active_revision,
                memory_tree_reference=commit_input.memory_tree_reference,
                trajectory_reference=commit_input.trajectory_reference,
                maintenance_report=commit_input.maintenance_report,
            )
        else:
            committed = catalog_client.create_learning_revision(
                operation_id=commit_input.operation_id,
                expected_active_revision=commit_input.expected_active_revision,
                extraction_ids=list(commit_input.extraction_ids),
                memory_tree_reference=commit_input.memory_tree_reference,
                trajectory_reference=commit_input.trajectory_reference,
                maintenance_report=commit_input.maintenance_report,
            )
    except MemoryAutomationPausedError:
        return {
            "ok": True,
            "skipped": True,
            "processed_count": 0,
            "reason": "automation_paused",
        }
    except MemoryPublicationAbandonedError:
        return {
            "ok": True,
            "skipped": True,
            "processed_count": 0,
            "reason": "publication_abandoned",
        }
    except MemoryCatalogConflictError as error:
        raise ApplicationError(
            str(error),
            type="MEMORY_CATALOG_REVISION_CONFLICT",
            non_retryable=True,
        ) from error
    source = committed.get("source")
    if (
        not isinstance(source, dict)
        or source.get("kind") != commit_input.source_kind
        or source.get("operation_id") != commit_input.operation_id
    ):
        raise RuntimeError("Catalog returned a different revision operation identity.")
    processed_count = (
        len(commit_input.extraction_ids)
        if commit_input.source_kind == "learning"
        else 0
    )
    summary = (
        f"Processed {processed_count} memory observations."
        if commit_input.source_kind == "learning"
        else "Reorganized the active memory tree."
    )
    return {
        "ok": True,
        "skipped": False,
        "summary": summary,
        "processed_count": processed_count,
    }


@activity.defn
def count_pending_memory_observations_activity() -> dict[str, Any]:
    from sec_review_agents.features import memory_processing_enabled
    from sec_review_agents.memory.catalog_client import (
        configured_memory_catalog_client,
    )

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
        if request.mode == "learning":
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
            assert prepared.commit_input is not None
            result = await workflow.execute_activity(
                commit_memory_tree_revision_activity,
                prepared.commit_input,
                schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
                retry_policy=activity_retry_policy(),
            )
        else:
            raise RuntimeError(
                "Memory maintenance activity returned an invalid result."
            )
        if result.get("reason") in {"automation_paused", "publication_abandoned"}:
            return result
        if request.mode == "learning":
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
