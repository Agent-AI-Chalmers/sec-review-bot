from datetime import timedelta
from typing import Any

from temporalio import activity, workflow
from temporalio.common import RetryPolicy

ACTIVITY_RETRY_MAXIMUM_ATTEMPTS = 3


@activity.defn
def prepare_internal_workflow_activity(workflow_name: str, run_id: str) -> None:
    from sec_review_agents.observability.diagnostics import bind_workflow_context

    bind_workflow_context(workflow=workflow_name, run_id=run_id)


def activity_retry_policy() -> RetryPolicy:
    return RetryPolicy(
        initial_interval=timedelta(seconds=2),
        backoff_coefficient=2.0,
        maximum_interval=timedelta(seconds=30),
        maximum_attempts=ACTIVITY_RETRY_MAXIMUM_ATTEMPTS,
    )


async def execute_activity(
    activity_fn: Any,
    *args: Any,
    timeout_seconds: int,
) -> Any:
    return await workflow.execute_activity(
        activity_fn,
        args=list(args),
        schedule_to_close_timeout=timedelta(seconds=timeout_seconds),
        retry_policy=activity_retry_policy(),
    )


__all__ = [
    "ACTIVITY_RETRY_MAXIMUM_ATTEMPTS",
    "activity_retry_policy",
    "execute_activity",
    "prepare_internal_workflow_activity",
]
