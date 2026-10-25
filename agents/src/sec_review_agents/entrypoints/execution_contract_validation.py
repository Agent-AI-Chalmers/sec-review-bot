"""Locate and validate the current execution-contract request schema."""

import json
import os
from dataclasses import asdict
from functools import cache
from importlib.resources import files
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

from sec_review_agents.entrypoints.execution_contract import (
    EXECUTION_WORKFLOW_TYPE,
    RUN_ID_PATTERN_TEXT,
    ExecutionRequest,
)

_CONTRACT_LABEL = "execution-contract/v1"
_SCHEMA_RELATIVE_PATH = Path("execution-contract/v1/execution-request.schema.json")


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
            "execution-contract",
            "v1",
            "execution-request.schema.json",
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


def validate_execution_request(request: ExecutionRequest) -> None:
    """Reject an execution request that violates the current execution contract."""
    errors = sorted(
        Draft202012Validator(_schema()).iter_errors(asdict(request)),
        key=lambda error: list(error.path),
    )
    if errors:
        error = errors[0]
        location = ".".join(str(part) for part in error.absolute_path) or "<root>"
        raise ValueError(
            f"Execution request does not match {_CONTRACT_LABEL} "
            f"at {location}: {error.message}"
        )


__all__ = ["validate_execution_request"]
