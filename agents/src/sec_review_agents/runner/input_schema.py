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


def _schema_root() -> Traversable:
    packaged = files("sec_review_agents.resources").joinpath("contracts", "v4")
    if packaged.joinpath("common.schema.json").is_file():
        return packaged

    # A source checkout reads the same canonical files before a wheel has
    # copied them into package data.
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "contracts" / "schemas" / "v4"
        if (candidate / "common.schema.json").is_file():
            return candidate
    raise RuntimeError(
        "Could not locate contract v4 schemas for Runner input validation."
    )


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
        workflow: Draft202012Validator(schemas[schema_name], registry=registry)
        for workflow, schema_name in INPUT_SCHEMA_BY_WORKFLOW.items()
    }


def validate_v4_workflow_input(input_data: Any, workflow: str) -> None:
    """Reject caller input that does not match the workflow's public v4 shape."""
    validator = _validators().get(workflow)
    if validator is None:
        raise ValueError(
            f"Unsupported workflow for workflow input preparation: {workflow}"
        )
    errors = sorted(
        validator.iter_errors(input_data), key=lambda error: list(error.path)
    )
    if not errors:
        return
    error = errors[0]
    location = ".".join(str(part) for part in error.absolute_path)
    label = f" at {location}" if location else ""
    raise ValueError(f"Runner input does not match contract v4{label}: {error.message}")


__all__ = ["INPUT_SCHEMA_BY_WORKFLOW", "validate_v4_workflow_input"]
