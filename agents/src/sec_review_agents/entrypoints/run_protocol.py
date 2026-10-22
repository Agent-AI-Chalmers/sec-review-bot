"""Define shared run IDs, workflow names, validation, and error responses."""

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
# The run ID already belongs to a different workflow request.
EXECUTION_RUN_CONFLICT = "EXECUTION_RUN_CONFLICT"
# The Execution Worker has no stored execution record for the requested run ID.
EXECUTION_RUN_NOT_FOUND = "EXECUTION_RUN_NOT_FOUND"
# A completed workflow returned data that is not a valid execution response.
EXECUTION_RESPONSE_INVALID = "EXECUTION_RESPONSE_INVALID"
# The workflow execution failed before it could return a valid result.
EXECUTION_FAILED = "EXECUTION_FAILED"

# A status query names every run the caller wants a status token for. The bound keeps one
# request from expanding into an unbounded number of workflow reads: without it, a caller
# mistake becomes load on the Execution Worker rather than a rejection.
MAX_STATUS_QUERY_RUN_IDS = 200


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
    "EXECUTION_FAILED",
    "EXECUTION_REQUEST_INVALID",
    "EXECUTION_RESPONSE_INVALID",
    "EXECUTION_RUN_CONFLICT",
    "EXECUTION_RUN_NOT_FOUND",
    "EXECUTION_WORKFLOW_UNSUPPORTED",
    "MAX_STATUS_QUERY_RUN_IDS",
    "RUN_ID_PATTERN",
    "RUN_ID_REQUIREMENT_MESSAGE",
    "SUPPORTED_EXECUTION_WORKFLOWS",
    "build_execution_error",
    "is_supported_workflow",
    "validate_run_id",
]
