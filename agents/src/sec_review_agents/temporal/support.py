from datetime import timedelta

from temporalio import activity
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


__all__ = [
    "ACTIVITY_RETRY_MAXIMUM_ATTEMPTS",
    "activity_retry_policy",
    "prepare_internal_workflow_activity",
]
