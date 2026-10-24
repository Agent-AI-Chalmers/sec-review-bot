"""Define the Execution protocol: workflow support, run ID validation, and errors."""

from typing import Any

from sec_review_agents.entrypoints.contract_schema import INPUT_SCHEMA_BY_WORKFLOW
from sec_review_agents.entrypoints.execution_contract import (
    RUN_ID_PATTERN,
    RUN_ID_PATTERN_TEXT,
)

SUPPORTED_EXECUTION_WORKFLOWS = frozenset(INPUT_SCHEMA_BY_WORKFLOW)
RUN_ID_REQUIREMENT_MESSAGE = f"Execution run_id must match {RUN_ID_PATTERN_TEXT}."

# The caller sent a request that the Execution Worker cannot validate or prepare.
EXECUTION_REQUEST_INVALID = "EXECUTION_REQUEST_INVALID"
# The caller asked the Execution Worker to start a workflow that it does not support.
EXECUTION_WORKFLOW_UNSUPPORTED = "EXECUTION_WORKFLOW_UNSUPPORTED"


def build_execution_error(
    *,
    code: str,
    message: str,
    category: str = "internal",
    retryable: bool = False,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "category": category,
        "code": code,
        "message": message,
        "retryable": retryable,
        "details": details or {},
    }


def validate_run_id(value: object) -> str:
    if not isinstance(value, str) or value == "":
        raise ValueError("Execution request body is missing run_id.")
    if RUN_ID_PATTERN.fullmatch(value) is None:
        raise ValueError(RUN_ID_REQUIREMENT_MESSAGE)
    return value


def is_supported_workflow(workflow: str) -> bool:
    return workflow in SUPPORTED_EXECUTION_WORKFLOWS


__all__ = [
    "EXECUTION_REQUEST_INVALID",
    "EXECUTION_WORKFLOW_UNSUPPORTED",
    "RUN_ID_REQUIREMENT_MESSAGE",
    "SUPPORTED_EXECUTION_WORKFLOWS",
    "build_execution_error",
    "is_supported_workflow",
    "validate_run_id",
]
