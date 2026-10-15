import sys
from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

# `CONTRACT_VERSION` is defined once in `sec_review_agents.contract_version`, a
# module with no imports, so this hook can import it even in an isolated build
# environment (where the runtime's third-party dependencies are absent). The
# source tree is not installed yet at hook time, so put it on `sys.path` first.
_SRC = Path("src")


def _contract_version_dir(project_root: Path) -> str:
    src = str((project_root / _SRC).resolve())
    if src not in sys.path:
        sys.path.insert(0, src)
    from sec_review_agents.contract_version import CONTRACT_VERSION_DIR

    return CONTRACT_VERSION_DIR


def _contract_schemas_root(project_root: Path) -> Path:
    contract_version_dir = _contract_version_dir(project_root)
    candidates = (
        project_root.parent
        / "contracts"
        / "integration-contract"
        / contract_version_dir
        / "schemas",
        project_root
        / "contracts"
        / "integration-contract"
        / contract_version_dir
        / "schemas",
    )
    for candidate in candidates:
        if (candidate / "common.schema.json").is_file():
            return candidate
    raise RuntimeError(
        f"Could not locate canonical contract {contract_version_dir} schemas for packaging."
    )


class CustomBuildHook(BuildHookInterface):
    """Include canonical schemas in both source and wheel distributions."""

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        contract_version_dir = _contract_version_dir(Path(self.root))
        schema_root = _contract_schemas_root(Path(self.root))
        force_include = build_data.setdefault("force_include", {})
        if self.target_name == "sdist":
            force_include[str(schema_root)] = (
                f"contracts/integration-contract/{contract_version_dir}/schemas"
            )
        elif self.target_name == "wheel":
            force_include[str(schema_root)] = (
                f"sec_review_agents/resources/contracts/{contract_version_dir}"
            )
