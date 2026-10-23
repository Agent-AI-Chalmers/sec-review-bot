"""Workflow and activity registration owned by the Memory Worker."""

from typing import Any

from sec_review_agents.memory.extraction_workflow import (
    MemoryExtractionWorkflow,
    run_memory_extraction_activity,
)
from sec_review_agents.memory.maintenance_workflow import (
    MemoryMaintenanceWorkflow,
    count_pending_memory_observations_activity,
    run_memory_maintenance_activity,
)

WORKFLOWS: list[Any] = [MemoryExtractionWorkflow, MemoryMaintenanceWorkflow]
ACTIVITIES: list[Any] = [
    count_pending_memory_observations_activity,
    run_memory_extraction_activity,
    run_memory_maintenance_activity,
]

__all__ = ["ACTIVITIES", "WORKFLOWS"]
