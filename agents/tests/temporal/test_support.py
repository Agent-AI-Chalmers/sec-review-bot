from datetime import timedelta
from types import SimpleNamespace

from sec_review_agents.temporal.support import (
    ACTIVITY_RETRY_MAXIMUM_ATTEMPTS,
    activity_retry_policy,
    activity_trace_labels,
)


def test_activity_retry_policy_preserves_production_backoff_contract() -> None:
    """Keep concurrency tests fast without weakening production retry behavior."""
    policy = activity_retry_policy()

    assert policy.initial_interval == timedelta(seconds=2)
    assert policy.backoff_coefficient == 2.0
    assert policy.maximum_interval == timedelta(seconds=30)
    assert policy.maximum_attempts == ACTIVITY_RETRY_MAXIMUM_ATTEMPTS == 3


def test_activity_trace_labels_include_temporal_attempt(monkeypatch) -> None:
    monkeypatch.setattr(
        "sec_review_agents.temporal.support.activity.info",
        lambda: SimpleNamespace(attempt=2),
    )

    assert activity_trace_labels(
        workflow_name="repository-review",
        run_id="run-1",
        case_id="case-1",
    ) == {
        "workflow": "repository-review",
        "run_id": "run-1",
        "temporal_activity_attempt": "2",
        "case_id": "case-1",
    }


def test_activity_trace_labels_omit_attempt_outside_temporal(monkeypatch) -> None:
    def raise_outside_activity() -> None:
        raise RuntimeError("not in activity context")

    monkeypatch.setattr(
        "sec_review_agents.temporal.support.activity.info",
        raise_outside_activity,
    )

    assert (
        activity_trace_labels(
            workflow_name="issue-review",
            run_id="run-1",
        )["temporal_activity_attempt"]
        is None
    )
