from collections.abc import Callable
from typing import Any

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


def test_repository_case_temporal_names_and_registration_remain_stable() -> None:
    """Moving Python modules must not rename types persisted in Temporal history."""
    from temporalio import activity, workflow

    from sec_review_agents.entrypoints.execution_worker.workflows import WORKFLOWS
    from sec_review_agents.workflows.repository_case import workflow as case

    assert case.RepositoryCaseReviewWorkflow in WORKFLOWS
    definition = workflow._Definition.must_from_class(case.RepositoryCaseReviewWorkflow)
    assert definition.name == "RepositoryCaseReviewWorkflow"
    activities: dict[str, Callable[..., Any]] = {
        "prepare_repository_case_activity": case.prepare_repository_case_activity,
        "analyze_repository_case_activity": case.analyze_repository_case_activity,
        "score_repository_case_cvss_activity": case.score_repository_case_cvss_activity,
        "mitigate_repository_case_activity": case.mitigate_repository_case_activity,
        "verify_repository_case_activity": case.verify_repository_case_activity,
        "archive_repository_case_feedback_attempt_activity": case.archive_repository_case_feedback_attempt_activity,
        "build_repository_case_result_activity": case.build_repository_case_result_activity,
    }
    for name, function in activities.items():
        assert function in EXECUTION_ACTIVITIES
        assert activity._Definition.must_from_callable(function).name == name
