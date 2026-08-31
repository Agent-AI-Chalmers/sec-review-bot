import re
from typing import Any

from sec_review_agents.runner.input_preparation import (
    INPUT_ALLOWED_FIELDS_BY_WORKFLOW,
    prepare_workflow_input,
    workflow_artifact_root,
)

SUPPORTED_RUNNER_WORKFLOWS = frozenset(INPUT_ALLOWED_FIELDS_BY_WORKFLOW)
RUN_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
RUN_ID_REQUIREMENT_MESSAGE = (
    "Runner run_id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$."
)


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


def validate_run_request_body(body: Any) -> str | None:
    if not isinstance(body, dict):
        return "Runner run request body must be a JSON object."
    try:
        validate_run_id(body.get("run_id"))
    except ValueError as error:
        return str(error)
    if not isinstance(body.get("input"), dict):
        return "Runner run request body is missing input."
    return None


def validate_run_id(value: object) -> str:
    if not isinstance(value, str) or value == "":
        raise ValueError("Runner run request body is missing run_id.")
    if RUN_ID_PATTERN.fullmatch(value) is None:
        raise ValueError(RUN_ID_REQUIREMENT_MESSAGE)
    return value


def prepare_runner_input_data(
    caller_input: dict[str, Any],
    *,
    run_id: str,
    workflow: str,
) -> dict[str, Any]:
    validated_run_id = validate_run_id(run_id)
    return prepare_workflow_input(
        caller_input,
        workflow,
        artifact_root_path=workflow_artifact_root(
            caller_input,
            run_id=validated_run_id,
        ),
    )


def is_supported_workflow(workflow: str) -> bool:
    return workflow in SUPPORTED_RUNNER_WORKFLOWS


__all__ = [
    "RUN_ID_PATTERN",
    "RUN_ID_REQUIREMENT_MESSAGE",
    "SUPPORTED_RUNNER_WORKFLOWS",
    "build_runner_error",
    "is_supported_workflow",
    "prepare_runner_input_data",
    "validate_run_id",
    "validate_run_request_body",
]
