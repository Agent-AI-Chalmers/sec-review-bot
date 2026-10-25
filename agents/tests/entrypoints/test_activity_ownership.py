from sec_review_agents.entrypoints.execution_worker.workflows import (
    ACTIVITIES as EXECUTION_ACTIVITIES,
)
from sec_review_agents.entrypoints.memory_extraction_worker.workflows import (
    ACTIVITIES as MEMORY_EXTRACTION_ACTIVITIES,
)
from sec_review_agents.entrypoints.memory_extraction_worker.workflows import (
    WORKFLOWS as MEMORY_EXTRACTION_WORKFLOWS,
)
from sec_review_agents.entrypoints.memory_maintenance_worker.workflows import (
    ACTIVITIES as MEMORY_MAINTENANCE_ACTIVITIES,
)
from sec_review_agents.entrypoints.memory_maintenance_worker.workflows import (
    WORKFLOWS as MEMORY_MAINTENANCE_WORKFLOWS,
)
from sec_review_agents.run_diagnostics.publication import (
    publish_run_diagnostic_activity,
)


def test_execution_worker_owns_run_diagnostic_publication() -> None:
    """Publication belongs to review execution; memory only consumes bundles."""
    assert publish_run_diagnostic_activity in EXECUTION_ACTIVITIES
    assert publish_run_diagnostic_activity not in MEMORY_EXTRACTION_ACTIVITIES
    assert publish_run_diagnostic_activity not in MEMORY_MAINTENANCE_ACTIVITIES


def test_memory_worker_registrations_are_disjoint() -> None:
    """Extraction and maintenance must remain independently deployable pools."""
    assert set(MEMORY_EXTRACTION_WORKFLOWS).isdisjoint(MEMORY_MAINTENANCE_WORKFLOWS)
    assert set(MEMORY_EXTRACTION_ACTIVITIES).isdisjoint(MEMORY_MAINTENANCE_ACTIVITIES)
