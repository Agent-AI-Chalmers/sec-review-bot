"""Run the shared setup-declaration corpus through the execution parser.

The corpus lives under `contracts/setup-declaration/v1/corpus/` and is also
executed by the GitHub integration's `setup-declaration` validator. Both sides
must agree on what a declaration may contain; this shared corpus fails a test on
whichever side drifts.
"""

from pathlib import Path

import pytest

from sec_review_agents.entrypoints.setup_declaration import (
    SetupDeclarationError,
    parse_setup_declaration,
)
from tests.contract_fixtures import (
    contract_setup_declaration_files,
    contract_setup_declaration_manifest,
)


def test_fixture_corpus_is_present() -> None:
    assert (
        contract_setup_declaration_files()
    ), "expected shared setup-declaration fixtures"


def test_manifest_classifies_every_corpus_file() -> None:
    manifest = contract_setup_declaration_manifest()
    files = {path.name for path in contract_setup_declaration_files()}
    listed = set(manifest["valid"]) | set(manifest["invalid"])
    assert files == listed
    assert set(manifest["valid"]).isdisjoint(manifest["invalid"])


@pytest.mark.parametrize(
    "path", contract_setup_declaration_files(), ids=lambda p: p.name
)
def test_shared_fixtures_classify_consistently(path: Path) -> None:
    content = path.read_text(encoding="utf-8")
    if path.name.startswith("valid-"):
        parse_setup_declaration(content)
    else:
        with pytest.raises(SetupDeclarationError):
            parse_setup_declaration(content)
