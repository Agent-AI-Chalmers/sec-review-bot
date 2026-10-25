"""Workflow and activity registration owned by the Memory Worker."""

from typing import Any

from sec_review_agents.workflows.memory.extraction import (
    MemoryExtractionWorkflow,
    run_memory_extraction_activity,
)
from sec_review_agents.workflows.memory.maintenance import (
    MemoryMaintenanceWorkflow,
    commit_memory_tree_revision_activity,
    count_pending_memory_observations_activity,
    prepare_memory_maintenance_activity,
)

WORKFLOWS: list[Any] = [MemoryExtractionWorkflow, MemoryMaintenanceWorkflow]
ACTIVITIES: list[Any] = [
    count_pending_memory_observations_activity,
    commit_memory_tree_revision_activity,
    prepare_memory_maintenance_activity,
    run_memory_extraction_activity,
]

__all__ = ["ACTIVITIES", "WORKFLOWS"]
