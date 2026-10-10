"""Define shared run IDs, workflow names, validation, and error responses."""

import re
from typing import Any

from sec_review_agents.entrypoints.contract_schema import INPUT_SCHEMA_BY_WORKFLOW

SUPPORTED_RUNNER_WORKFLOWS = frozenset(INPUT_SCHEMA_BY_WORKFLOW)
RUN_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
RUN_ID_REQUIREMENT_MESSAGE = (
    "Runner run_id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$."
)

# The caller sent a request that the Runner cannot validate or prepare.
RUNNER_REQUEST_INVALID = "RUNNER_REQUEST_INVALID"
# The caller asked the Runner to start a workflow that it does not support.
RUNNER_WORKFLOW_UNSUPPORTED = "RUNNER_WORKFLOW_UNSUPPORTED"
# The run ID already belongs to a different workflow request.
RUNNER_RUN_CONFLICT = "RUNNER_RUN_CONFLICT"
# The Runner has no stored execution record for the requested run ID.
RUNNER_RUN_NOT_FOUND = "RUNNER_RUN_NOT_FOUND"
# A completed workflow returned data that is not a valid Runner response.
RUNNER_RESPONSE_INVALID = "RUNNER_RESPONSE_INVALID"
# The workflow execution failed before it could return a valid result.
RUNNER_EXECUTION_FAILED = "RUNNER_EXECUTION_FAILED"

# A status query names every run the caller wants a status token for. The bound keeps one
# request from expanding into an unbounded number of workflow reads: without it, a caller
# mistake becomes load on the Runner rather than a rejection.
MAX_STATUS_QUERY_RUN_IDS = 200


def build_runner_error(
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
        raise ValueError("Runner run request body is missing run_id.")
    if RUN_ID_PATTERN.fullmatch(value) is None:
        raise ValueError(RUN_ID_REQUIREMENT_MESSAGE)
    return value


def is_supported_workflow(workflow: str) -> bool:
    return workflow in SUPPORTED_RUNNER_WORKFLOWS


__all__ = [
    "MAX_STATUS_QUERY_RUN_IDS",
    "RUNNER_EXECUTION_FAILED",
    "RUNNER_REQUEST_INVALID",
    "RUNNER_RESPONSE_INVALID",
    "RUNNER_RUN_CONFLICT",
    "RUNNER_RUN_NOT_FOUND",
    "RUNNER_WORKFLOW_UNSUPPORTED",
    "RUN_ID_PATTERN",
    "RUN_ID_REQUIREMENT_MESSAGE",
    "SUPPORTED_RUNNER_WORKFLOWS",
    "build_runner_error",
    "is_supported_workflow",
    "validate_run_id",
]
