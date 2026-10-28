"""Locate and validate the current Execution Workflow input schema."""

import json
import os
from dataclasses import asdict
from functools import cache
from importlib.resources import files
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator  # type: ignore[import-untyped]
from pydantic import JsonValue

from sec_review_agents.contract_versions import EXECUTION_WORKFLOW_VERSION
from sec_review_agents.entrypoints.execution_workflow import (
    EXECUTION_WORKFLOW_TYPE,
    RUN_ID_PATTERN_TEXT,
    ExecutionRuntimeConfig,
    ExecutionWorkflowInput,
)

_CONTRACT_LABEL = f"execution-workflow/{EXECUTION_WORKFLOW_VERSION}"
_SCHEMA_RELATIVE_PATH = (
    Path("execution-workflow")
    / EXECUTION_WORKFLOW_VERSION
    / "execution-workflow-input.schema.json"
)


@cache
def _schema() -> dict[str, Any]:
    """Load the authoritative schema and reject drift from workflow constants."""
    configured = os.environ.get("SEC_REVIEW_CONTRACTS_ROOT")
    if configured is not None:
        path = Path(configured) / _SCHEMA_RELATIVE_PATH
        if not path.is_file():
            raise RuntimeError(
                f"SEC_REVIEW_CONTRACTS_ROOT={configured} does not contain "
                f"{_SCHEMA_RELATIVE_PATH}."
            )
        schema = json.loads(path.read_text(encoding="utf-8"))
    else:
        packaged = files("sec_review_agents.resources").joinpath(
            "contracts",
            "execution-workflow",
            EXECUTION_WORKFLOW_VERSION,
            "execution-workflow-input.schema.json",
        )
        if packaged.is_file():
            schema = json.loads(packaged.read_text(encoding="utf-8"))
        else:
            schema = _load_source_checkout_schema()

    if schema["x-temporal-workflow-type"] != EXECUTION_WORKFLOW_TYPE:
        raise RuntimeError(
            "Execution workflow type does not match its contract schema."
        )
    if schema["properties"]["run_id"]["pattern"] != RUN_ID_PATTERN_TEXT:
        raise RuntimeError(
            "Execution run ID pattern does not match its contract schema."
        )
    return schema


def _load_source_checkout_schema() -> dict[str, Any]:
    cwd = Path.cwd()
    for root in (cwd.parent / "contracts", cwd / "contracts"):
        path = root / _SCHEMA_RELATIVE_PATH
        if path.is_file():
            return json.loads(path.read_text(encoding="utf-8"))
    raise RuntimeError(f"Could not locate {_CONTRACT_LABEL} contract schema.")


def parse_execution_workflow_input(value: JsonValue) -> ExecutionWorkflowInput:
    """Validate a raw Temporal payload before projecting it into runtime data."""
    errors = sorted(
        Draft202012Validator(_schema()).iter_errors(value),
        key=lambda error: list(error.path),
    )
    if errors:
        error = errors[0]
        location = ".".join(str(part) for part in error.absolute_path) or "<root>"
        raise ValueError(
            f"Execution Workflow input does not match {_CONTRACT_LABEL} "
            f"at {location}: {error.message}"
        )

    if not isinstance(value, dict):
        raise AssertionError("schema-valid Execution Workflow input must be an object")
    workflow_name = value["workflow"]
    run_id = value["run_id"]
    caller_input = value["input"]
    timeout_seconds = value["timeout_seconds"]
    runtime_value = value.get("runtime")
    if not isinstance(workflow_name, str):
        raise AssertionError("schema-valid workflow must be a string")
    if not isinstance(run_id, str):
        raise AssertionError("schema-valid run_id must be a string")
    if not isinstance(caller_input, dict):
        raise AssertionError("schema-valid input must be an object")
    if not isinstance(timeout_seconds, int) or isinstance(timeout_seconds, bool):
        raise AssertionError("schema-valid timeout_seconds must be an integer")

    runtime: ExecutionRuntimeConfig | None = None
    if runtime_value is not None:
        if not isinstance(runtime_value, dict):
            raise AssertionError("schema-valid runtime must be an object or null")
        runtime = {}
        workspace_image = runtime_value.get("workspace_image")
        if workspace_image is not None:
            if not isinstance(workspace_image, str):
                raise AssertionError(
                    "schema-valid runtime.workspace_image must be a string"
                )
            runtime["workspace_image"] = workspace_image

    return ExecutionWorkflowInput(
        workflow=workflow_name,
        run_id=run_id,
        input=caller_input,
        timeout_seconds=timeout_seconds,
        runtime=runtime,
    )


def validate_execution_workflow_input(request: ExecutionWorkflowInput) -> None:
    """Reject a typed input whose values violate the Execution Workflow contract."""
    parse_execution_workflow_input(asdict(request))


__all__ = [
    "parse_execution_workflow_input",
    "validate_execution_workflow_input",
]
