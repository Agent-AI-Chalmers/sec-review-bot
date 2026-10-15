import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator  # type: ignore[import-untyped]
from referencing import Registry, Resource

from sec_review_agents.entrypoints.contract_schema import CONTRACT_VERSION_DIR


def _workspace_root() -> Path:
    """Locate the repository root by the presence of the shared `contracts/` tree.

    The probe is the contracts root's own `README.md`, not any one family inside
    it: each family derives its own paths from `CONTRACTS_ROOT`, so no family
    depends on another family's location, and a merely-named `contracts/`
    directory (such as this package's own `tests/contracts/`) does not match.
    """
    for candidate in Path(__file__).resolve().parents:
        if (candidate / "contracts" / "README.md").is_file():
            return candidate
    raise RuntimeError("Could not locate workspace contracts root.")


CONTRACTS_ROOT = _workspace_root() / "contracts"

# --- integration-contract family ------------------------------------------

INTEGRATION_CONTRACT_ROOT = CONTRACTS_ROOT / "integration-contract"
_FIXTURES_ROOT = INTEGRATION_CONTRACT_ROOT / CONTRACT_VERSION_DIR / "fixtures"
_SCHEMAS_ROOT = INTEGRATION_CONTRACT_ROOT / CONTRACT_VERSION_DIR / "schemas"


def contract_fixture(name: str) -> dict[str, Any]:
    return json.loads((_FIXTURES_ROOT / name).read_text(encoding="utf-8"))


def contract_fixture_manifest() -> dict[str, Any]:
    return json.loads((_FIXTURES_ROOT / "manifest.json").read_text(encoding="utf-8"))


def contract_fixture_files() -> list[Path]:
    return sorted(_FIXTURES_ROOT.glob("*.json"))


# --- setup-declaration family ---------------------------------------------
#
# A sibling family, not part of integration-contract: its rules are decision
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
