"""Load and enforce the stable Temporal boundary owned by execution-contract/v1."""

import json
import os
import re
from dataclasses import asdict, dataclass
from functools import cache
from importlib.resources import files
from pathlib import Path
from typing import Any, TypedDict

from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

_SCHEMA_RELATIVE_PATH = Path("execution-contract/v1/execution-request.schema.json")


@cache
def _schema() -> dict[str, Any]:
    configured = os.environ.get("SEC_REVIEW_CONTRACTS_ROOT")
    if configured is not None:
        path = Path(configured) / _SCHEMA_RELATIVE_PATH
        if not path.is_file():
            raise RuntimeError(
                f"SEC_REVIEW_CONTRACTS_ROOT={configured} does not contain "
                f"{_SCHEMA_RELATIVE_PATH}."
            )
        return json.loads(path.read_text(encoding="utf-8"))

    packaged = files("sec_review_agents.resources").joinpath(
        "contracts", "execution-contract", "v1", "execution-request.schema.json"
    )
    if packaged.is_file():
        return json.loads(packaged.read_text(encoding="utf-8"))

    for root in (Path.cwd().parent / "contracts", Path.cwd() / "contracts"):
        path = root / _SCHEMA_RELATIVE_PATH
        if path.is_file():
            return json.loads(path.read_text(encoding="utf-8"))
    raise RuntimeError("Could not locate execution-contract/v1 contract schema.")


EXECUTION_WORKFLOW_TYPE = str(_schema()["x-temporal-workflow-type"])
RUN_ID_PATTERN_TEXT = str(_schema()["properties"]["run_id"]["pattern"])
RUN_ID_PATTERN = re.compile(RUN_ID_PATTERN_TEXT)


class ExecutionRuntimeConfig(TypedDict, total=False):
    workspace_image: str


@dataclass(frozen=True)
class ExecutionRequest:
    workflow: str
    run_id: str
    input_data: dict[str, Any]
    timeout_seconds: int
    runtime: ExecutionRuntimeConfig | None = None


def validate_execution_request(request: ExecutionRequest) -> None:
    errors = sorted(
        Draft202012Validator(_schema()).iter_errors(asdict(request)),
        key=lambda error: list(error.path),
    )
    if errors:
        error = errors[0]
        location = ".".join(str(part) for part in error.absolute_path) or "<root>"
        raise ValueError(
            "Execution request does not match execution-contract/v1 "
            f"at {location}: {error.message}"
        )


__all__ = [
    "EXECUTION_WORKFLOW_TYPE",
    "RUN_ID_PATTERN",
    "RUN_ID_PATTERN_TEXT",
    "ExecutionRequest",
    "ExecutionRuntimeConfig",
    "validate_execution_request",
]
