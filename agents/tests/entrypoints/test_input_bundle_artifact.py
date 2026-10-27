import json

import pytest

from sec_review_agents.contract_versions import INPUT_BUNDLE_ARTIFACT_VERSION
from sec_review_agents.entrypoints.input_bundle_artifact import (
    validate_input_bundle_archive,
)
from tests.project_paths import CONTRACTS_ROOT

CORPUS = (
    CONTRACTS_ROOT
    / "tar-zstd-artifact"
    / "profiles"
    / "input-bundle"
    / INPUT_BUNDLE_ARTIFACT_VERSION
    / "corpus"
)


def test_input_bundle_reader_matches_shared_corpus() -> None:
    manifest = json.loads((CORPUS / "manifest.json").read_text(encoding="utf-8"))

    for case in manifest["corpus"]:
        archive = CORPUS / case["file"]
        if case["expected"] == "valid":
            validate_input_bundle_archive(archive)
        else:
            with pytest.raises(ValueError):
                validate_input_bundle_archive(archive)


def test_input_bundle_corpus_files_are_real_archives() -> None:
    manifest = json.loads((CORPUS / "manifest.json").read_text(encoding="utf-8"))

    assert {case["file"] for case in manifest["corpus"]} == {
        path.name for path in CORPUS.glob("*.tar.zst")
    }
