"""Worker-owned execution workflow and dispatch into review workflows."""

from datetime import timedelta
from typing import Any

from temporalio import activity, workflow

from sec_review_agents.entrypoints.execution_contract import (
    EXECUTION_WORKFLOW_TYPE,
    ExecutionRequest,
    validate_execution_request,
)
from sec_review_agents.entrypoints.execution_protocol import (
    EXECUTION_REQUEST_INVALID,
    EXECUTION_WORKFLOW_UNSUPPORTED,
)
from sec_review_agents.temporal.support import (
    activity_retry_policy,
)
from sec_review_agents.workflows.issue.workflow import IssueReviewWorkflow
from sec_review_agents.workflows.pull_request.workflow import PullRequestReviewWorkflow
from sec_review_agents.workflows.repository.workflow import (
    RepositoryReviewWorkflow,
)
from sec_review_agents.workflows.review_request import (
    ReviewPostProcessingPolicy,
    ReviewWorkflowRequest,
)


@activity.defn
def prepare_execution_run_activity(request: ExecutionRequest) -> dict[str, Any]:
    from sec_review_agents.entrypoints.execution_protocol import build_execution_error
    from sec_review_agents.entrypoints.input_preparation import prepare_run_input
    from sec_review_agents.features import memory_processing_enabled
    from sec_review_agents.observability.diagnostics import (
        bind_workflow_context,
        log_diagnostic,
    )
    from sec_review_agents.observability.trace_context import clear_trace_context
    from sec_review_agents.runtime.runtime_config import runtime_context_from_config

    try:
        validate_execution_request(request)
        bind_workflow_context(workflow=request.workflow, run_id=request.run_id)
        log_diagnostic(
            "execution_dispatch",
            input_type=type(request.input_data).__name__,
            run_id=request.run_id,
        )
        return {
            "ok": True,
            "workflow": request.workflow,
            "run_id": request.run_id,
            "prepared_input": prepare_run_input(
                request.input_data,
                run_id=request.run_id,
                workflow=request.workflow,
            ),
            "runtime_context": runtime_context_from_config(request.runtime),
            "timeout_seconds": request.timeout_seconds,
            "memory_processing_enabled": memory_processing_enabled(),
        }
    except ValueError as error:
        return {
            "ok": False,
            "error": build_execution_error(
                code=EXECUTION_REQUEST_INVALID,
                category="input",
                message=str(error),
                details={"name": error.__class__.__name__},
            ),
        }
    except NotImplementedError as error:
        return {
            "ok": False,
            "error": build_execution_error(
                code=EXECUTION_WORKFLOW_UNSUPPORTED,
                category="workflow",
                message=str(error),
            ),
        }
    finally:
        clear_trace_context()


@workflow.defn(name=EXECUTION_WORKFLOW_TYPE)
class ExecutionWorkflow:
    @workflow.run
    async def run(self, request: ExecutionRequest) -> dict[str, Any]:
        prepared = await workflow.execute_activity(
            prepare_execution_run_activity,
            request,
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        if prepared.get("ok") is False:
            return prepared
        internal_request = ReviewWorkflowRequest(
            workflow=prepared["workflow"],
            run_id=prepared["run_id"],
            prepared_input=prepared["prepared_input"],
            timeout_seconds=prepared["timeout_seconds"],
            runtime_context=prepared["runtime_context"],
            post_processing=ReviewPostProcessingPolicy(
                memory_processing_enabled=prepared["memory_processing_enabled"],
                diagnostic_publication="managed",
            ),
        )
        if request.workflow == "issue-review":
            result = await workflow.execute_child_workflow(
                IssueReviewWorkflow.run,
                internal_request,
                id=_child_workflow_id(request),
            )
        elif request.workflow == "pull-request-review":
            result = await workflow.execute_child_workflow(
                PullRequestReviewWorkflow.run,
                internal_request,
                id=_child_workflow_id(request),
            )
        elif request.workflow == "repository-review":
            result = await workflow.execute_child_workflow(
                RepositoryReviewWorkflow.run,
                internal_request,
                id=_child_workflow_id(request),
            )
        else:
            return {
                "ok": False,
                "error": {
                    "category": "workflow",
                    "code": EXECUTION_WORKFLOW_UNSUPPORTED,
                    "message": f"Unsupported workflow: {request.workflow}",
                    "retryable": False,
                    "details": {},
                },
            }
        return {
            **result,
        }


def _child_workflow_id(request: ExecutionRequest) -> str:
    return f"{request.run_id}:{request.workflow}"


__all__ = [
    "ExecutionWorkflow",
    "prepare_execution_run_activity",
]
