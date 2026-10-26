import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator  # type: ignore[import-untyped]
from referencing import Registry, Resource

from sec_review_agents.contract_versions import EXECUTION_API_VERSION
from tests.project_paths import CONTRACTS_ROOT

# --- execution-api family ------------------------------------------

EXECUTION_API_ROOT = CONTRACTS_ROOT / "execution-api"
_FIXTURES_ROOT = EXECUTION_API_ROOT / EXECUTION_API_VERSION / "fixtures"
_SCHEMAS_ROOT = EXECUTION_API_ROOT / EXECUTION_API_VERSION / "schemas"


def contract_fixture(name: str) -> dict[str, Any]:
    return json.loads((_FIXTURES_ROOT / name).read_text(encoding="utf-8"))


def contract_fixture_manifest() -> dict[str, Any]:
    return json.loads((_FIXTURES_ROOT / "manifest.json").read_text(encoding="utf-8"))


def contract_fixture_files() -> list[Path]:
    return sorted(_FIXTURES_ROOT.glob("*.json"))


# --- setup-declaration family ---------------------------------------------
#
# A sibling family, not part of execution-api: its rules are decision
# logic enforced in code, so it carries a shared corpus rather than JSON Schema
# fixtures. Derived from CONTRACTS_ROOT directly -- never from another family's
# location.
_SETUP_DECLARATION_CORPUS_ROOT = CONTRACTS_ROOT / "setup-declaration" / "v1" / "corpus"


def contract_setup_declaration_files() -> list[Path]:
    return sorted(_SETUP_DECLARATION_CORPUS_ROOT.glob("*.yml"))


def contract_setup_declaration_manifest() -> dict[str, Any]:
    return json.loads(
        (_SETUP_DECLARATION_CORPUS_ROOT / "manifest.json").read_text(encoding="utf-8")
    )


def contract_schema(name: str) -> dict[str, Any]:
    return json.loads((_SCHEMAS_ROOT / name).read_text(encoding="utf-8"))


def contract_schema_files() -> list[Path]:
    return sorted(_SCHEMAS_ROOT.glob("*.schema.json"))


def contract_schema_registry() -> Registry:
    resources: list[tuple[str, Resource]] = []
    for schema_file in contract_schema_files():
        schema = contract_schema(schema_file.name)
        resource = Resource.from_contents(schema)
        resources.append((schema["$id"], resource))
        resources.append((schema_file.name, resource))
    return Registry().with_resources(resources)


def contract_validator(schema_name: str) -> Draft202012Validator:
    return Draft202012Validator(
        contract_schema(schema_name),
        registry=contract_schema_registry(),
    )


def format_schema_errors(errors: Iterable) -> str:
    return "\n".join(
        f"{'/'.join(str(part) for part in error.path) or '<root>'}: {error.message}"
        for error in errors
    )
