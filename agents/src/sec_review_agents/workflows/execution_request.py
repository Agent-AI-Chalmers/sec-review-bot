from dataclasses import dataclass
from typing import Any

from sec_review_agents.runtime.runtime_config import RunnerRuntimeContext


@dataclass(frozen=True)
class InternalWorkflowRequest:
    workflow: str
    run_id: str
    prepared_input: dict[str, Any]
    timeout_seconds: int
    runtime_context: RunnerRuntimeContext
    # Controls only whether this review run registers a pending memory extraction
    # job; scheduled extraction and maintenance are managed separately.
    memory_extraction_registration_enabled: bool = True


__all__ = ["InternalWorkflowRequest"]
