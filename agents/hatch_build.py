from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


def _contract_schemas_root(project_root: Path) -> Path:
    candidates = (
        project_root.parent / "contracts" / "integration-contract" / "v5" / "schemas",
        project_root / "contracts" / "integration-contract" / "v5" / "schemas",
    )
    for candidate in candidates:
        if (candidate / "common.schema.json").is_file():
            return candidate
    raise RuntimeError("Could not locate canonical contract v5 schemas for packaging.")


class CustomBuildHook(BuildHookInterface):
    """Include canonical schemas in both source and wheel distributions."""

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        schema_root = _contract_schemas_root(Path(self.root))
        force_include = build_data.setdefault("force_include", {})
        if self.target_name == "sdist":
            force_include[str(schema_root)] = (
                "contracts/integration-contract/v5/schemas"
            )
        elif self.target_name == "wheel":
            force_include[str(schema_root)] = "sec_review_agents/resources/contracts/v5"
