"""Execute the canonical Memory Catalog response contract without coercion."""

import json
import os
import re
from functools import cache
from importlib.resources import files
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import yaml
from jsonschema import Draft202012Validator, FormatChecker

from sec_review_agents.contract_versions import MEMORY_CATALOG_API_VERSION


@cache
def _document() -> dict[str, Any]:
    relative = Path("memory-catalog-api") / MEMORY_CATALOG_API_VERSION / "openapi.yaml"
    configured = os.environ.get("SEC_REVIEW_CONTRACTS_ROOT")
    if configured is not None:
        path = Path(configured) / relative
        if not path.is_file():
            raise RuntimeError(
                f"SEC_REVIEW_CONTRACTS_ROOT does not contain {relative}."
            )
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    packaged = files("sec_review_agents.resources").joinpath(
        "contracts", *relative.parts
    )
    if packaged.is_file():
        return yaml.safe_load(packaged.read_text(encoding="utf-8"))
    for root in (Path.cwd().parent / "contracts", Path.cwd() / "contracts"):
        path = root / relative
        if path.is_file():
            return yaml.safe_load(path.read_text(encoding="utf-8"))
    raise RuntimeError(f"Could not locate {relative}.")


@cache
def _validator(schema_name: str) -> Draft202012Validator:
    schemas = json.loads(
        json.dumps(_document()["components"]["schemas"]).replace(
            "#/components/schemas/", "#/$defs/"
        )
    )
    return Draft202012Validator(
        {"$defs": schemas, "$ref": f"#/$defs/{schema_name}"},
        format_checker=FormatChecker(),
    )


def validate_catalog_response(method: str, path: str, status: int, value: Any) -> None:
    """Reject undocumented responses before a caller can interpret their fields."""
    pathname = urlsplit(path).path
    for template, operations in _document()["paths"].items():
        pattern = re.sub(r"\{[^}]+\}", "[^/]+", template)
        if re.fullmatch(pattern, pathname) is None:
            continue
        operation = operations.get(method.lower())
        if operation is None:
            continue
        response = operation["responses"].get(str(status))
        if response is None:
            raise RuntimeError(f"Undocumented Memory Catalog HTTP status {status}.")
        if "$ref" in response:
            reference = response["$ref"]
            response = _document()
            for part in reference.removeprefix("#/").split("/"):
                response = response[part]
        schema = response["content"]["application/json"]["schema"]
        schema_name = schema["$ref"].removeprefix("#/components/schemas/")
        error = next(_validator(schema_name).iter_errors(value), None)
        if error is not None:
            location = ".".join(str(part) for part in error.absolute_path) or "<root>"
            raise RuntimeError(
                f"Memory Catalog {schema_name} response violates contract at {location}: "
                f"{error.message}"
            )
        return
    raise RuntimeError(f"Undocumented Memory Catalog operation: {method} {pathname}.")
