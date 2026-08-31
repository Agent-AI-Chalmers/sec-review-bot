from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from temporalio import activity, workflow

from sec_review_agents.temporal.support import (
    activity_retry_policy,
)
from sec_review_agents.workflows.execution_request import InternalWorkflowRequest
from sec_review_agents.workflows.issue.workflow import IssueReviewWorkflow
from sec_review_agents.workflows.pull_request.workflow import PullRequestReviewWorkflow
from sec_review_agents.workflows.repository.workflow import (
    RepositoryReviewWorkflow,
)


@dataclass(frozen=True)
class RunnerExecutionRequest:
    workflow: str
    run_id: str
    input_data: dict[str, Any]
    timeout_seconds: int
    runtime: Any = None


_CHILD_WORKFLOW_ID_SUFFIXES = {
    "issue-review": "issue-review",
    "pull-request-review": "pull-request-review",
    "repository-review": "repository-review",
}


@activity.defn
def prepare_runner_run_activity(request: RunnerExecutionRequest) -> dict[str, Any]:
    from sec_review_agents.observability.diagnostics import (
        bind_workflow_context,
        log_diagnostic,
    )
    from sec_review_agents.observability.trace_context import clear_trace_context
    from sec_review_agents.runner.core import (
        build_runner_error,
        prepare_runner_input_data,
    )
    from sec_review_agents.runtime.runtime_config import runtime_context_from_config

    try:
        bind_workflow_context(workflow=request.workflow, run_id=request.run_id)
        log_diagnostic(
            "runner_dispatch",
            input_type=type(request.input_data).__name__,
            run_id=request.run_id,
        )
        return {
            "ok": True,
            "workflow": request.workflow,
            "run_id": request.run_id,
            "prepared_input": prepare_runner_input_data(
                request.input_data,
                run_id=request.run_id,
                workflow=request.workflow,
            ),
            "runtime_context": runtime_context_from_config(request.runtime),
            "timeout_seconds": request.timeout_seconds,
        }
    except ValueError as error:
        return {
            "ok": False,
            "error": build_runner_error(
                code="RUNNER_REQUEST_INVALID",
                category="input",
                message=str(error),
                details={"name": error.__class__.__name__},
            ),
        }
    except NotImplementedError as error:
        return {
            "ok": False,
            "error": build_runner_error(
                code="RUNNER_WORKFLOW_UNSUPPORTED",
                category="workflow",
                message=str(error),
            ),
        }
    finally:
        clear_trace_context()


@workflow.defn
class RunnerExecutionWorkflow:
    @workflow.run
    async def run(self, request: RunnerExecutionRequest) -> dict[str, Any]:
        prepared = await workflow.execute_activity(
            prepare_runner_run_activity,
            request,
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        if prepared.get("ok") is False:
            return prepared
        internal_request = InternalWorkflowRequest(
            workflow=prepared["workflow"],
            run_id=prepared["run_id"],
            prepared_input=prepared["prepared_input"],
            timeout_seconds=prepared["timeout_seconds"],
            runtime_context=prepared["runtime_context"],
        )
        if request.workflow == "issue-review":
            return await workflow.execute_child_workflow(
                IssueReviewWorkflow.run,
                internal_request,
                id=_child_workflow_id(request),
            )
        if request.workflow == "pull-request-review":
            return await workflow.execute_child_workflow(
                PullRequestReviewWorkflow.run,
                internal_request,
                id=_child_workflow_id(request),
            )
        if request.workflow == "repository-review":
            return await workflow.execute_child_workflow(
                RepositoryReviewWorkflow.run,
                internal_request,
                id=_child_workflow_id(request),
            )
        return {
            "ok": False,
            "error": {
                "category": "workflow",
                "code": "RUNNER_WORKFLOW_UNSUPPORTED",
                "message": f"Unsupported workflow: {request.workflow}",
                "retryable": False,
                "details": {},
            },
        }


def _child_workflow_id(request: RunnerExecutionRequest) -> str:
    suffix = _CHILD_WORKFLOW_ID_SUFFIXES.get(request.workflow, request.workflow)
    return f"{request.run_id}:{suffix}"


__all__ = [
    "RunnerExecutionRequest",
    "RunnerExecutionWorkflow",
    "prepare_runner_run_activity",
]
