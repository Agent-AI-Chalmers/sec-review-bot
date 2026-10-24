from sec_review_agents.entrypoints.execution_worker.workflows import (
    ACTIVITIES as EXECUTION_ACTIVITIES,
)
from sec_review_agents.entrypoints.memory_worker.workflows import (
    ACTIVITIES as MEMORY_ACTIVITIES,
)
from sec_review_agents.workflows.publish_run_diagnostic import (
    publish_run_diagnostic_activity,
)


def test_execution_worker_owns_run_diagnostic_publication() -> None:
    """Publication belongs to review execution; memory only consumes bundles."""
    assert publish_run_diagnostic_activity in EXECUTION_ACTIVITIES
    assert publish_run_diagnostic_activity not in MEMORY_ACTIVITIES
