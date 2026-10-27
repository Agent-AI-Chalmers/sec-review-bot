from pathlib import Path

import pytest

from sec_review_agents.contract_versions import (
    INPUT_BUNDLE_ARTIFACT_VERSION,
    MEMORY_TREE_ARTIFACT_VERSION,
    RUN_DIAGNOSTIC_ARTIFACT_VERSION,
    TAR_ZSTD_ENVELOPE_VERSION,
)
from tests.project_paths import CONTRACTS_ROOT


@pytest.mark.parametrize(
    ("family_root", "version"),
    [
        (
            Path("tar-zstd-artifact/envelope"),
            TAR_ZSTD_ENVELOPE_VERSION,
        ),
        (
            Path("tar-zstd-artifact/profiles/memory-tree"),
            MEMORY_TREE_ARTIFACT_VERSION,
        ),
        (
            Path("tar-zstd-artifact/profiles/input-bundle"),
            INPUT_BUNDLE_ARTIFACT_VERSION,
        ),
        (
            Path("tar-zstd-artifact/profiles/run-diagnostic"),
            RUN_DIAGNOSTIC_ARTIFACT_VERSION,
        ),
    ],
)
def test_artifact_contract_version_resolves_to_supported_contract(
    family_root: Path,
    version: str,
) -> None:
    contract_root = CONTRACTS_ROOT / family_root / version

    assert (contract_root / "SPEC.md").is_file()
    assert (contract_root / "corpus" / "manifest.json").is_file()
