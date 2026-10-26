"""Pure data definitions for the Execution Workflow input contract.

Workflow modules import this file inside Temporal's sandbox. Keep filesystem and
schema access in `execution_workflow_validation`, which runs only in activities.
"""

import re
from dataclasses import dataclass
from typing import Any, TypedDict

EXECUTION_WORKFLOW_TYPE = "execution-workflow"
RUN_ID_PATTERN_TEXT = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
RUN_ID_PATTERN = re.compile(RUN_ID_PATTERN_TEXT)


class ExecutionRuntimeConfig(TypedDict, total=False):
    workspace_image: str


@dataclass(frozen=True)
class ExecutionWorkflowInput:
    workflow: str
    run_id: str
    input: dict[str, Any]
    timeout_seconds: int
    runtime: ExecutionRuntimeConfig | None = None


__all__ = [
    "EXECUTION_WORKFLOW_TYPE",
    "RUN_ID_PATTERN",
    "RUN_ID_PATTERN_TEXT",
    "ExecutionRuntimeConfig",
    "ExecutionWorkflowInput",
]
