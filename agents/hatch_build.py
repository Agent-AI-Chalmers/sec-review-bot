from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

# On-disk directory holding the canonical contract schemas. This build hook runs
# before the runtime package is importable, so it cannot share the runtime
# CONTRACT_VERSION constant; the value is restated here as the single place the
# build needs to know the directory name.
CONTRACT_VERSION_DIR = "v6"


def _contract_schemas_root(project_root: Path) -> Path:
    candidates = (
        project_root.parent
        / "contracts"
        / "integration-contract"
        / CONTRACT_VERSION_DIR
        / "schemas",
        project_root
        / "contracts"
        / "integration-contract"
        / CONTRACT_VERSION_DIR
        / "schemas",
    )
    for candidate in candidates:
        if (candidate / "common.schema.json").is_file():
            return candidate
    raise RuntimeError(
        f"Could not locate canonical contract {CONTRACT_VERSION_DIR} schemas for packaging."
    )


class CustomBuildHook(BuildHookInterface):
    """Include canonical schemas in both source and wheel distributions."""

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        schema_root = _contract_schemas_root(Path(self.root))
        force_include = build_data.setdefault("force_include", {})
        if self.target_name == "sdist":
            force_include[str(schema_root)] = (
                f"contracts/integration-contract/{CONTRACT_VERSION_DIR}/schemas"
            )
        elif self.target_name == "wheel":
            force_include[str(schema_root)] = (
                f"sec_review_agents/resources/contracts/{CONTRACT_VERSION_DIR}"
            )
