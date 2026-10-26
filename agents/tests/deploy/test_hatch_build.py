"""The wheel build hook must carry schemas for the canonical contract versions.

The hook cannot import the runtime validator (it needs third-party dependencies
absent from an isolated build), but it imports `sec_review_agents.contract_versions`,
which has no imports of its own. These tests pin that link.
"""

import sys
from pathlib import Path

import hatch_build
from tests.project_paths import AGENTS_ROOT


def test_version_dir_matches_the_runtime_constant() -> None:
    from sec_review_agents.contract_versions import (
        EXECUTION_API_VERSION,
        EXECUTION_WORKFLOW_VERSION,
    )

    assert hatch_build._api_version(AGENTS_ROOT) == EXECUTION_API_VERSION
    assert hatch_build._contract_versions(AGENTS_ROOT) == (
        EXECUTION_API_VERSION,
        EXECUTION_WORKFLOW_VERSION,
    )


def test_version_module_has_no_imports() -> None:
    # The whole reason the hook can import it in an isolated build is that the
    # module pulls in nothing. A future import would silently break the build.
    import ast

    source = (
        AGENTS_ROOT / "src" / "sec_review_agents" / "contract_versions.py"
    ).read_text(encoding="utf-8")
    tree = ast.parse(source)
    imports = [
        node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom))
    ]
    assert imports == []


def test_schemas_root_resolves_for_the_derived_version() -> None:
    root = hatch_build._contract_schemas_root(AGENTS_ROOT)
    assert (root / "common.schema.json").is_file()
    # The resolved directory's version segment is the derived one.
    assert root.parent.name == hatch_build._api_version(AGENTS_ROOT)


def test_schemas_root_fails_loudly_for_unknown_version(tmp_path: Path) -> None:
    # A project root whose package reports a version with no schemas on disk must
    # raise rather than silently package nothing.
    import pytest

    (tmp_path / "src" / "sec_review_agents").mkdir(parents=True)
    (tmp_path / "src" / "sec_review_agents" / "contract_versions.py").write_text(
        'EXECUTION_API_VERSION = "v-does-not-exist"\n'
        'EXECUTION_WORKFLOW_VERSION = "v1"\n',
        encoding="utf-8",
    )
    # A stale cached module would mask the fake one under tmp_path.
    saved = sys.modules.pop("sec_review_agents.contract_versions", None)
    try:
        with pytest.raises(RuntimeError, match="Could not locate canonical contract"):
            hatch_build._contract_schemas_root(tmp_path)
    finally:
        sys.modules.pop("sec_review_agents.contract_versions", None)
        if saved is not None:
            sys.modules["sec_review_agents.contract_versions"] = saved


def test_workflow_input_schema_resolves_from_repository_layout() -> None:
    from sec_review_agents.contract_versions import EXECUTION_WORKFLOW_VERSION

    schema = hatch_build._workflow_input_schema_path(AGENTS_ROOT)

    assert schema == (
        AGENTS_ROOT.parent
        / "contracts"
        / "execution-workflow"
        / EXECUTION_WORKFLOW_VERSION
        / "execution-workflow-input.schema.json"
    )


def test_workflow_input_schema_resolves_from_sdist_layout(tmp_path: Path) -> None:
    from sec_review_agents.contract_versions import EXECUTION_WORKFLOW_VERSION

    schema = (
        tmp_path
        / "contracts"
        / "execution-workflow"
        / EXECUTION_WORKFLOW_VERSION
        / "execution-workflow-input.schema.json"
    )
    schema.parent.mkdir(parents=True)
    schema.write_text("{}", encoding="utf-8")

    assert hatch_build._workflow_input_schema_path(tmp_path) == schema
