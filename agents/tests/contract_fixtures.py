import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator  # type: ignore[import-untyped]
from referencing import Registry, Resource


def _workspace_root() -> Path:
    for candidate in Path(__file__).resolve().parents:
        if (
            candidate / "contracts" / "integration-contract" / "v5" / "fixtures"
        ).is_dir():
            return candidate
    raise RuntimeError("Could not locate workspace contract fixtures root.")


CONTRACT_ROOT = _workspace_root() / "contracts" / "integration-contract"


def _fixtures_root(version: str) -> Path:
    return CONTRACT_ROOT / version / "fixtures"


def _schemas_root(version: str) -> Path:
    return CONTRACT_ROOT / version / "schemas"


def contract_fixture(version: str, name: str) -> dict[str, Any]:
    return json.loads((_fixtures_root(version) / name).read_text(encoding="utf-8"))


def contract_fixture_manifest(version: str) -> dict[str, Any]:
    return json.loads(
        (_fixtures_root(version) / "manifest.json").read_text(encoding="utf-8")
    )


def contract_fixture_files(version: str) -> list[Path]:
    return sorted(_fixtures_root(version).glob("*.json"))


def contract_schema(version: str, name: str) -> dict[str, Any]:
    return json.loads((_schemas_root(version) / name).read_text(encoding="utf-8"))


def contract_schema_files(version: str) -> list[Path]:
    return sorted(_schemas_root(version).glob("*.schema.json"))


def contract_schema_registry(version: str) -> Registry:
    resources: list[tuple[str, Resource]] = []
    for schema_file in contract_schema_files(version):
        schema = contract_schema(version, schema_file.name)
        resource = Resource.from_contents(schema)
        resources.append((schema["$id"], resource))
        resources.append((schema_file.name, resource))
    return Registry().with_resources(resources)


def contract_validator(
    version: str,
    schema_name: str,
) -> Draft202012Validator:
    return Draft202012Validator(
        contract_schema(version, schema_name),
        registry=contract_schema_registry(version),
    )


def format_schema_errors(errors: Iterable) -> str:
    return "\n".join(
        f"{'/'.join(str(part) for part in error.path) or '<root>'}: {error.message}"
        for error in errors
    )
