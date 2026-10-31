from dataclasses import dataclass
from typing import Literal

from sec_review_agents.runtime.runtime_config import ExecutionRuntimeContext
from sec_review_agents.workflows.prepared_input import PreparedWorkflowInput


@dataclass(frozen=True)
class ReviewPostProcessingPolicy:
    # Execution policy stays separate from the review input and controls production.
    memory_processing_enabled: bool = True
    diagnostic_scheme: Literal["file", "s3"] = "file"


@dataclass(frozen=True)
class ReviewWorkflowRequest:
    workflow: str
    run_id: str
    prepared_input: PreparedWorkflowInput
    timeout_seconds: int
    runtime_context: ExecutionRuntimeContext
    post_processing: ReviewPostProcessingPolicy = ReviewPostProcessingPolicy()


__all__ = ["ReviewPostProcessingPolicy", "ReviewWorkflowRequest"]
