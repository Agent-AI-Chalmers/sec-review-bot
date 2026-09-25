from datetime import timedelta

from sec_review_agents.temporal.support import (
    ACTIVITY_RETRY_MAXIMUM_ATTEMPTS,
    activity_retry_policy,
)


def test_activity_retry_policy_preserves_production_backoff_contract() -> None:
    """Keep concurrency tests fast without weakening production retry behavior."""
    policy = activity_retry_policy()

    assert policy.initial_interval == timedelta(seconds=2)
    assert policy.backoff_coefficient == 2.0
    assert policy.maximum_interval == timedelta(seconds=30)
    assert policy.maximum_attempts == ACTIVITY_RETRY_MAXIMUM_ATTEMPTS == 3
