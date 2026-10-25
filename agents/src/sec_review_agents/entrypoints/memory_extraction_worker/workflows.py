"""Workflow and activity registration owned by the Memory Extraction Worker."""

from typing import Any

from sec_review_agents.workflows.memory.extraction import (
    MemoryExtractionWorkflow,
    run_memory_extraction_activity,
)

WORKFLOWS: list[Any] = [MemoryExtractionWorkflow]
ACTIVITIES: list[Any] = [run_memory_extraction_activity]

__all__ = ["ACTIVITIES", "WORKFLOWS"]
