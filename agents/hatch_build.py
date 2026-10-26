import sys
from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

# Contract versions live in an import-free module so this hook can read them in
# an isolated build environment, where runtime dependencies are absent. The
# source tree is not installed yet at hook time, so put it on `sys.path` first.
_SRC = Path("src")


def _contract_versions(project_root: Path) -> tuple[str, str]:
    src = str((project_root / _SRC).resolve())
    if src not in sys.path:
        sys.path.insert(0, src)
    from sec_review_agents.contract_versions import (
        EXECUTION_API_VERSION,
        EXECUTION_WORKFLOW_VERSION,
    )

    return EXECUTION_API_VERSION, EXECUTION_WORKFLOW_VERSION


def _api_version(project_root: Path) -> str:
    return _contract_versions(project_root)[0]


def _contract_schemas_root(project_root: Path) -> Path:
    api_version = _api_version(project_root)
    candidates = (
        project_root.parent / "contracts" / "execution-api" / api_version / "schemas",
        project_root / "contracts" / "execution-api" / api_version / "schemas",
    )
    for candidate in candidates:
        if (candidate / "common.schema.json").is_file():
            return candidate
    raise RuntimeError(
        f"Could not locate canonical contract {api_version} schemas for packaging."
    )


def _workflow_input_schema_path(project_root: Path) -> Path:
    workflow_version = _contract_versions(project_root)[1]
    relative_path = (
        Path("contracts")
        / "execution-workflow"
        / workflow_version
        / "execution-workflow-input.schema.json"
    )
    # A repository build keeps contracts beside agents/. The sdist hook copies
    # them under the archive root, which becomes project_root for its wheel build.
    candidates = (project_root.parent / relative_path, project_root / relative_path)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise RuntimeError(
        f"Could not locate execution-workflow/{workflow_version} input schema."
    )


class CustomBuildHook(BuildHookInterface):
    """Include canonical schemas in both source and wheel distributions."""

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        api_version, workflow_version = _contract_versions(Path(self.root))
        schema_root = _contract_schemas_root(Path(self.root))
        force_include = build_data.setdefault("force_include", {})
        runtime_schema = _workflow_input_schema_path(Path(self.root))
        if self.target_name == "sdist":
            force_include[str(schema_root)] = (
                f"contracts/execution-api/{api_version}/schemas"
            )
            force_include[str(runtime_schema)] = (
                f"contracts/execution-workflow/{workflow_version}/"
                "execution-workflow-input.schema.json"
            )
        elif self.target_name == "wheel":
            force_include[str(schema_root)] = (
                f"sec_review_agents/resources/contracts/{api_version}"
            )
            force_include[str(runtime_schema)] = (
                "sec_review_agents/resources/contracts/execution-workflow/"
                f"{workflow_version}/"
                "execution-workflow-input.schema.json"
            )
