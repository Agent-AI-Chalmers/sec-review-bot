from dataclasses import dataclass
from typing import Any, Literal

from sec_review_agents.runtime.runtime_config import ExecutionRuntimeContext


@dataclass(frozen=True)
class ReviewPostProcessingPolicy:
    # Execution policy stays separate from the review input and controls production.
    memory_processing_enabled: bool = True
    diagnostic_publication: Literal["local", "managed"] = "local"


@dataclass(frozen=True)
class ReviewWorkflowRequest:
    workflow: str
    run_id: str
    prepared_input: dict[str, Any]
    timeout_seconds: int
    runtime_context: ExecutionRuntimeContext
    post_processing: ReviewPostProcessingPolicy = ReviewPostProcessingPolicy()


__all__ = ["ReviewPostProcessingPolicy", "ReviewWorkflowRequest"]
