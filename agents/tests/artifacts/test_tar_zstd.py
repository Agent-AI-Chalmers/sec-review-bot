import json

import pytest

from sec_review_agents.artifacts.tar_zstd import validate_restricted_pax_archive
from sec_review_agents.contract_versions import TAR_ZSTD_ENVELOPE_VERSION
from tests.project_paths import CONTRACTS_ROOT

CORPUS = (
    CONTRACTS_ROOT
    / "tar-zstd-artifact"
    / "envelope"
    / TAR_ZSTD_ENVELOPE_VERSION
    / "corpus"
)


def test_restricted_pax_reader_matches_shared_corpus() -> None:
    manifest = json.loads((CORPUS / "manifest.json").read_text(encoding="utf-8"))

    for case in manifest["corpus"]:
        archive = CORPUS / case["file"]
        if case["expected"] == "valid":
            validate_restricted_pax_archive(archive)
        else:
            with pytest.raises(ValueError):
                validate_restricted_pax_archive(archive)
