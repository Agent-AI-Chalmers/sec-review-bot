"""Validate public Runner workflow inputs and results against contract schemas."""

import json
import os
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


# The subtree under a contracts root that holds the canonical v6 schemas. An
# operator points `SEC_REVIEW_CONTRACTS_ROOT` at the directory that contains it.
_CONTRACT_SUBTREE = Path("integration-contract") / "v6" / "schemas"
_SCHEMAS_ROOT_ENV = "SEC_REVIEW_CONTRACTS_ROOT"


def _has_schemas(root: Path) -> bool:
    return (root / _CONTRACT_SUBTREE / "common.schema.json").is_file()


def _schema_root() -> Traversable:
    """Locate the canonical v6 schemas.

    Resolution is explicit and ordered, not a search:

    1. `SEC_REVIEW_CONTRACTS_ROOT`, if set, is authoritative — it is the operator's
       declaration of where the schemas are. A set-but-wrong value is an error rather
       than something to fall through, so a misconfigured deployment fails loudly
       instead of silently reading a different copy.
    2. The schemas packaged in the wheel (`sec_review_agents.resources`), which is how
       an installed Runner carries them.
    3. The source-checkout layout, read relative to the working directory. This is the
       finite pair the repository uses (a checkout run from `agents/`, or from the
       repository root); the Docker image (`WORKDIR /app`, schemas at `/contracts`) is
       the first of these. Nothing here walks the filesystem upward without bound — the
       location is a fact about the deployment, not something to guess at.
    """
    configured = os.environ.get(_SCHEMAS_ROOT_ENV)
    if configured is not None:
        root = Path(configured)
        if not _has_schemas(root):
            raise RuntimeError(
                f"{_SCHEMAS_ROOT_ENV}={configured} does not contain "
                f"{_CONTRACT_SUBTREE / 'common.schema.json'}."
            )
        return root / _CONTRACT_SUBTREE

    packaged = files("sec_review_agents.resources").joinpath("contracts", "v6")
    if packaged.joinpath("common.schema.json").is_file():
        return packaged

    cwd = Path.cwd()
    for candidate in (cwd.parent / "contracts", cwd / "contracts"):
        if _has_schemas(candidate):
            return candidate / _CONTRACT_SUBTREE

    raise RuntimeError(
        "Could not locate contract v6 schemas for Runner validation. Set "
        f"{_SCHEMAS_ROOT_ENV} to the directory containing {_CONTRACT_SUBTREE}."
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
    for schema in schemas.values():
        resource = Resource.from_contents(schema)
        resources.append((schema["$id"], resource))
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
        f"Runner {value_label} does not match contract v6{label}: {error.message}"
    )


def validate_v6_workflow_input(input_data: Any, workflow: str) -> None:
    """Reject caller input that does not match the workflow's public v6 shape."""
    _validate_workflow_contract(
        input_data,
        workflow,
        schema_by_workflow=INPUT_SCHEMA_BY_WORKFLOW,
        value_label="input",
    )


def validate_v6_workflow_result(result: Any, workflow: str) -> None:
    """Reject a workflow result that does not match the public v6 shape."""
    _validate_workflow_contract(
        result,
        workflow,
        schema_by_workflow=RESULT_SCHEMA_BY_WORKFLOW,
        value_label="result",
    )


__all__ = [
    "INPUT_SCHEMA_BY_WORKFLOW",
    "RESULT_SCHEMA_BY_WORKFLOW",
    "validate_v6_workflow_input",
    "validate_v6_workflow_result",
]
