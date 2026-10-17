"""The wheel build hook must carry the schemas of the runtime's contract version.

The hook cannot import the runtime validator (it needs third-party dependencies
absent from an isolated build), but it imports `sec_review_agents.contract_version`,
a module with no imports of its own, so the version is read from one place rather
than restated. These tests pin that link.
"""

import sys
from pathlib import Path

import hatch_build
from tests.project_paths import AGENTS_ROOT


def test_version_dir_matches_the_runtime_constant() -> None:
    from sec_review_agents.contract_version import CONTRACT_VERSION

    assert hatch_build._contract_version_dir(AGENTS_ROOT) == CONTRACT_VERSION


def test_version_module_has_no_imports() -> None:
    # The whole reason the hook can import it in an isolated build is that the
    # module pulls in nothing. A future import would silently break the build.
    import ast

    source = (
        AGENTS_ROOT / "src" / "sec_review_agents" / "contract_version.py"
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
    assert root.parent.name == hatch_build._contract_version_dir(AGENTS_ROOT)


def test_schemas_root_fails_loudly_for_unknown_version(tmp_path: Path) -> None:
    # A project root whose package reports a version with no schemas on disk must
    # raise rather than silently package nothing.
    import pytest

    (tmp_path / "src" / "sec_review_agents").mkdir(parents=True)
    (tmp_path / "src" / "sec_review_agents" / "contract_version.py").write_text(
        'CONTRACT_VERSION_DIR = "v-does-not-exist"\n', encoding="utf-8"
    )
    # A stale cached module would mask the fake one under tmp_path.
    saved = sys.modules.pop("sec_review_agents.contract_version", None)
    try:
        with pytest.raises(RuntimeError, match="Could not locate canonical contract"):
            hatch_build._contract_schemas_root(tmp_path)
    finally:
        sys.modules.pop("sec_review_agents.contract_version", None)
        if saved is not None:
            sys.modules["sec_review_agents.contract_version"] = saved
