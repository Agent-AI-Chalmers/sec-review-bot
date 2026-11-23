from typing import Literal, NotRequired, TypedDict

from temporalio import workflow
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.temporal.config import DEFAULT_MEMORY_EXTRACTION_TASK_QUEUE
from sec_review_agents.workflows.memory.extraction import (
    MemoryExtractionRequest,
    MemoryExtractionWorkflow,
    memory_extraction_workflow_id,
)


class MemoryExtractionStartResult(TypedDict):
    unit_id: str
    workflow_id: str
    status: Literal["started", "already_started", "start_failed"]
    error_code: NotRequired[Literal["MEMORY_EXTRACTION_START_FAILED"]]


async def schedule_memory_extractions(
    *,
    source_workflow: str,
    run_id: str,
    execution_archive: ArtifactReference,
    unit_ids: list[str],
    timeout_seconds: int,
    enabled: bool,
) -> list[MemoryExtractionStartResult]:
    """Schedule best-effort memory extraction after a review artifact is final.

    Start one child workflow per review unit and wait only for Temporal to accept
    each start, not for extraction to finish. The children use ``ABANDON`` so
    they can outlive the review workflow, and a failure to start one unit is
    recorded without failing the review or preventing the remaining starts.

    The workflow ID is derived from the artifact digest and review unit. Along
    with ``REJECT_DUPLICATE``, this makes repeated scheduling report an existing
    extraction instead of starting duplicate work. This helper must therefore
    run in workflow context: it records child-workflow lifecycle commands in the
    parent's deterministic history rather than delegating orchestration to an
    activity.
    """
    extractions: list[MemoryExtractionStartResult] = []
    if not enabled:
        return extractions

    digest = execution_archive.digest
    for unit_id in unit_ids:
        extraction_id = memory_extraction_workflow_id(
            execution_archive_digest=digest,
            unit_id=unit_id,
        )
        extraction: MemoryExtractionStartResult = {
            "unit_id": unit_id,
            "workflow_id": extraction_id,
            "status": "started",
        }
        try:
            await workflow.start_child_workflow(
                MemoryExtractionWorkflow.run,
                MemoryExtractionRequest(
                    source_workflow=source_workflow,
                    run_id=run_id,
                    unit_id=unit_id,
                    execution_archive=execution_archive,
                    timeout_seconds=timeout_seconds,
                ),
                id=extraction_id,
                task_queue=DEFAULT_MEMORY_EXTRACTION_TASK_QUEUE,
                parent_close_policy=workflow.ParentClosePolicy.ABANDON,
                id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
            )
        except WorkflowAlreadyStartedError:
            extraction["status"] = "already_started"
        # Optional extraction failures belong in the scheduling result.
        except Exception as error:  # noqa: BLE001
            workflow.logger.warning(
                "Failed to start memory extraction %s: %s",
                extraction_id,
                error,
            )
            extraction["status"] = "start_failed"
            extraction["error_code"] = "MEMORY_EXTRACTION_START_FAILED"
        extractions.append(extraction)
    return extractions


__all__ = ["MemoryExtractionStartResult", "schedule_memory_extractions"]
