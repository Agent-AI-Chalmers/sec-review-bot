"""Validate public Runner workflow inputs and results against contract schemas."""

import json
from functools import cache
from importlib.resources import files
from importlib.resources.abc import Traversable
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator  # type: ignore[import-untyped]
from referencing import Registry, Resource

INPUT_SCHEMA_BY_WORKFLOW = {
    "issue-review": "issue-review-input.schema.json",
    "pull-request-review": "pull-request-review-input.schema.json",
    "repository-review": "repository-review-input.schema.json",
}

RESULT_SCHEMA_BY_WORKFLOW = {
    "issue-review": "issue-review-result.schema.json",
    "pull-request-review": "pull-request-review-result.schema.json",
    "repository-review": "repository-review-result.schema.json",
}


def _schema_root() -> Traversable:
    packaged = files("sec_review_agents.resources").joinpath("contracts", "v5")
    if packaged.joinpath("common.schema.json").is_file():
        return packaged

    # A source checkout reads the same canonical files before a wheel has
    # copied them into package data.
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "contracts" / "integration-contract" / "v5" / "schemas"
        if (candidate / "common.schema.json").is_file():
            return candidate
    raise RuntimeError("Could not locate contract v5 schemas for Runner validation.")


@cache
def _validators() -> dict[str, Draft202012Validator]:
    root = _schema_root()
    schemas = {
        resource.name: json.loads(resource.read_text(encoding="utf-8"))
        for resource in root.iterdir()
        if resource.name.endswith(".schema.json")
    }
    resources: list[tuple[str, Resource]] = []
    for name, schema in schemas.items():
        resource = Resource.from_contents(schema)
        resources.extend(((name, resource), (schema["$id"], resource)))
    registry = Registry().with_resources(resources)
    return {
        schema_name: Draft202012Validator(schema, registry=registry)
        for schema_name, schema in schemas.items()
    }


def _validate_workflow_contract(
    value: Any,
    workflow: str,
    *,
    schema_by_workflow: dict[str, str],
    value_label: str,
) -> None:
    schema_name = schema_by_workflow.get(workflow)
    if schema_name is None:
        raise ValueError(
            f"Unsupported workflow for {value_label} validation: {workflow}"
        )
    validator = _validators()[schema_name]
    errors = sorted(validator.iter_errors(value), key=lambda error: list(error.path))
    if not errors:
        return
    error = errors[0]
    location = ".".join(str(part) for part in error.absolute_path)
    label = f" at {location}" if location else ""
    raise ValueError(
        f"Runner {value_label} does not match contract v5{label}: {error.message}"
    )


def validate_v5_workflow_input(input_data: Any, workflow: str) -> None:
    """Reject caller input that does not match the workflow's public v5 shape."""
    _validate_workflow_contract(
        input_data,
        workflow,
        schema_by_workflow=INPUT_SCHEMA_BY_WORKFLOW,
        value_label="input",
    )


def validate_v5_workflow_result(result: Any, workflow: str) -> None:
    """Reject a workflow result that does not match the public v5 shape."""
    _validate_workflow_contract(
        result,
        workflow,
        schema_by_workflow=RESULT_SCHEMA_BY_WORKFLOW,
        value_label="result",
    )


__all__ = [
    "INPUT_SCHEMA_BY_WORKFLOW",
    "RESULT_SCHEMA_BY_WORKFLOW",
    "validate_v5_workflow_input",
    "validate_v5_workflow_result",
]
