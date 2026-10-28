"""Worker-owned execution workflow and routing into review workflows."""

from datetime import timedelta
from typing import Any

from temporalio import activity, workflow

from sec_review_agents.entrypoints.execution_protocol import (
    EXECUTION_REQUEST_INVALID,
    EXECUTION_WORKFLOW_UNSUPPORTED,
)
from sec_review_agents.entrypoints.execution_workflow import EXECUTION_WORKFLOW_TYPE
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

EXECUTION_INPUT_PREPARATION_TIMEOUT = timedelta(minutes=5)


def _invalid_execution_request(error: ValueError) -> dict[str, Any]:
    from sec_review_agents.entrypoints.execution_protocol import build_execution_error

    return {
        "ok": False,
        "error": build_execution_error(
            code=EXECUTION_REQUEST_INVALID,
            category="input",
            message=str(error),
            details={"name": error.__class__.__name__},
        ),
    }


@activity.defn
def prepare_execution_run_activity(request: dict[str, Any]) -> dict[str, Any]:
    from sec_review_agents.entrypoints.execution_workflow_validation import (
        parse_execution_workflow_input,
    )
    from sec_review_agents.entrypoints.input_preparation import prepare_run_input
    from sec_review_agents.features import memory_processing_enabled
    from sec_review_agents.observability.diagnostics import log_diagnostic
    from sec_review_agents.observability.trace_context import bind_trace_context
    from sec_review_agents.runtime.runtime_config import runtime_context_from_config

    try:
        parsed_request = parse_execution_workflow_input(request)
        # This scope enriches preparation logs only. Downstream Temporal
        # activities receive run_id in their request and bind it again locally.
        with bind_trace_context(
            workflow=parsed_request.workflow,
            run_id=parsed_request.run_id,
        ):
            log_diagnostic(
                "execution_workflow_input",
                input_type=type(parsed_request.input).__name__,
                run_id=parsed_request.run_id,
            )
            return {
                "ok": True,
                "workflow": parsed_request.workflow,
                "run_id": parsed_request.run_id,
                "prepared_input": prepare_run_input(
                    parsed_request.input,
                    run_id=parsed_request.run_id,
                    workflow=parsed_request.workflow,
                ),
                "runtime_context": runtime_context_from_config(parsed_request.runtime),
                "timeout_seconds": parsed_request.timeout_seconds,
                "memory_processing_enabled": memory_processing_enabled(),
            }
    except ValueError as error:
        return _invalid_execution_request(error)
    except NotImplementedError as error:
        from sec_review_agents.entrypoints.execution_protocol import (
            build_execution_error,
        )

        return {
            "ok": False,
            "error": build_execution_error(
                code=EXECUTION_WORKFLOW_UNSUPPORTED,
                category="workflow",
                message=str(error),
            ),
        }


@workflow.defn(name=EXECUTION_WORKFLOW_TYPE)
class ExecutionWorkflow:
    @workflow.run
    async def run(self, request: dict[str, Any]) -> dict[str, Any]:
        prepared = await workflow.execute_activity(
            prepare_execution_run_activity,
            request,
            schedule_to_close_timeout=EXECUTION_INPUT_PREPARATION_TIMEOUT,
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
                diagnostic_scheme="s3",
            ),
        )
        if prepared["workflow"] == "issue-review":
            result = await workflow.execute_child_workflow(
                IssueReviewWorkflow.run,
                internal_request,
                id=_child_workflow_id(prepared["run_id"], prepared["workflow"]),
            )
        elif prepared["workflow"] == "pull-request-review":
            result = await workflow.execute_child_workflow(
                PullRequestReviewWorkflow.run,
                internal_request,
                id=_child_workflow_id(prepared["run_id"], prepared["workflow"]),
            )
        elif prepared["workflow"] == "repository-review":
            result = await workflow.execute_child_workflow(
                RepositoryReviewWorkflow.run,
                internal_request,
                id=_child_workflow_id(prepared["run_id"], prepared["workflow"]),
            )
        else:
            return {
                "ok": False,
                "error": {
                    "category": "workflow",
                    "code": EXECUTION_WORKFLOW_UNSUPPORTED,
                    "message": f"Unsupported workflow: {prepared['workflow']}",
                    "retryable": False,
                    "details": {},
                },
            }
        return {
            **result,
        }


def _child_workflow_id(run_id: str, workflow_name: str) -> str:
    return f"{run_id}:{workflow_name}"


__all__ = [
    "EXECUTION_INPUT_PREPARATION_TIMEOUT",
    "ExecutionWorkflow",
    "prepare_execution_run_activity",
]
