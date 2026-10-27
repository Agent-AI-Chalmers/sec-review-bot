from datetime import timedelta

from temporalio import activity
from temporalio.common import RetryPolicy

ACTIVITY_RETRY_MAXIMUM_ATTEMPTS = 3
REVIEW_EXECUTION_STATISTICS_SCOPE = "review-execution"


def activity_retry_policy() -> RetryPolicy:
    return RetryPolicy(
        initial_interval=timedelta(seconds=2),
        backoff_coefficient=2.0,
        maximum_interval=timedelta(seconds=30),
        maximum_attempts=ACTIVITY_RETRY_MAXIMUM_ATTEMPTS,
    )


def activity_trace_labels(
    *,
    workflow_name: str,
    run_id: str,
    **labels: str | None,
) -> dict[str, str | None]:
    """Build trace labels that each model-calling activity binds locally.

    The run ID comes from serialized workflow input because ContextVar state
    does not cross Temporal activity boundaries.
    """
    try:
        attempt = str(activity.info().attempt)
    except RuntimeError:
        # Direct activity unit tests run outside a Temporal activity context.
        attempt = None
    return {
        "workflow": workflow_name,
        "run_id": run_id,
        "statistics_scope": REVIEW_EXECUTION_STATISTICS_SCOPE,
        "temporal_activity_attempt": attempt,
        **labels,
    }


__all__ = [
    "ACTIVITY_RETRY_MAXIMUM_ATTEMPTS",
    "REVIEW_EXECUTION_STATISTICS_SCOPE",
    "activity_retry_policy",
    "activity_trace_labels",
]
