from typing import Any

from temporalio import workflow
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError

from sec_review_agents.temporal.config import DEFAULT_MEMORY_TASK_QUEUE
from sec_review_agents.workflows.memory.extraction import (
    MemoryExtractionRequest,
    MemoryExtractionWorkflow,
    memory_extraction_workflow_id,
)


async def schedule_memory_extractions(
    *,
    source_workflow: str,
    run_id: str,
    diagnostic_bundle: dict[str, Any],
    review_unit_ids: list[str],
    timeout_seconds: int,
    enabled: bool,
) -> dict[str, Any]:
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
    result: dict[str, Any] = {"extractions": []}
    if not enabled:
        return result

    digest = str(diagnostic_bundle["digest"])
    for review_unit_id in review_unit_ids:
        extraction_id = memory_extraction_workflow_id(
            transcript_digest=digest,
            review_unit_id=review_unit_id,
        )
        extraction = {
            "review_unit_id": review_unit_id,
            "workflow_id": extraction_id,
        }
        try:
            await workflow.start_child_workflow(
                MemoryExtractionWorkflow.run,
                MemoryExtractionRequest(
                    source_workflow=source_workflow,
                    run_id=run_id,
                    review_unit_id=review_unit_id,
                    diagnostic_bundle=diagnostic_bundle,
                    timeout_seconds=timeout_seconds,
                ),
                id=extraction_id,
                task_queue=DEFAULT_MEMORY_TASK_QUEUE,
                parent_close_policy=workflow.ParentClosePolicy.ABANDON,
                id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
            )
            extraction["status"] = "started"
        except WorkflowAlreadyStartedError:
            extraction["status"] = "already_started"
        except Exception as error:
            workflow.logger.warning(
                "Failed to start memory extraction %s: %s",
                extraction_id,
                error,
            )
            extraction["status"] = "start_failed"
            extraction["error_code"] = "MEMORY_EXTRACTION_START_FAILED"
        result["extractions"].append(extraction)
    return result


__all__ = ["schedule_memory_extractions"]
