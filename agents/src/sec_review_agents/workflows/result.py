"""The successful Execution envelope shared by the review workflows."""

from typing import Any, Literal, TypedDict

from sec_review_agents.workflows.memory.scheduling import MemoryExtractionStartResult


class ReviewWorkflowSuccess(TypedDict):
    ok: Literal[True]
    result: dict[str, Any]
    memory_processing: dict[str, list[MemoryExtractionStartResult]] | None
    # JSON is produced by ExecutionArchive.to_artifact_storage after reference validation.
    artifact_storage: dict[str, Any]
