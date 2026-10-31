"""Worker-owned execution workflow and routing into review workflows."""

from datetime import timedelta
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from temporalio import activity, workflow

from sec_review_agents.entrypoints.execution_protocol import (
    EXECUTION_REQUEST_INVALID,
    EXECUTION_WORKFLOW_UNSUPPORTED,
    build_execution_error,
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


class PreparationFailure(BaseModel):
    """Preparation failure facts, projected into the public error at workflow exit."""

    model_config = ConfigDict(frozen=True)

    code: str
    category: Literal["input", "workflow"]
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


def _invalid_execution_request(error: ValueError) -> PreparationFailure:
    return PreparationFailure(
        code=EXECUTION_REQUEST_INVALID,
        category="input",
        message=str(error),
        details={"name": error.__class__.__name__},
    )


@activity.defn
def prepare_execution_run_activity(
    request: dict[str, Any],
) -> ReviewWorkflowRequest | PreparationFailure:
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
            return ReviewWorkflowRequest(
                workflow=parsed_request.workflow,
                run_id=parsed_request.run_id,
                prepared_input=prepare_run_input(
                    parsed_request.input,
                    run_id=parsed_request.run_id,
                    workflow=parsed_request.workflow,
                ),
                runtime_context=runtime_context_from_config(parsed_request.runtime),
                timeout_seconds=parsed_request.timeout_seconds,
                post_processing=ReviewPostProcessingPolicy(
                    memory_processing_enabled=memory_processing_enabled(),
                    diagnostic_scheme="s3",
                ),
            )
    except ValueError as error:
        return _invalid_execution_request(error)
    except NotImplementedError as error:
        return PreparationFailure(
            code=EXECUTION_WORKFLOW_UNSUPPORTED,
            category="workflow",
            message=str(error),
        )


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
        if isinstance(prepared, PreparationFailure):
            return {
                "ok": False,
                "error": build_execution_error(
                    code=prepared.code,
                    category=prepared.category,
                    message=prepared.message,
                    details=prepared.details,
                ),
            }
        if prepared.workflow == "issue-review":
            result = await workflow.execute_child_workflow(
                IssueReviewWorkflow.run,
                prepared,
                id=_child_workflow_id(prepared.run_id, prepared.workflow),
            )
        elif prepared.workflow == "pull-request-review":
            result = await workflow.execute_child_workflow(
                PullRequestReviewWorkflow.run,
                prepared,
                id=_child_workflow_id(prepared.run_id, prepared.workflow),
            )
        elif prepared.workflow == "repository-review":
            result = await workflow.execute_child_workflow(
                RepositoryReviewWorkflow.run,
                prepared,
                id=_child_workflow_id(prepared.run_id, prepared.workflow),
            )
        else:
            return {
                "ok": False,
                "error": {
                    "category": "workflow",
                    "code": EXECUTION_WORKFLOW_UNSUPPORTED,
                    "message": f"Unsupported workflow: {prepared.workflow}",
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
