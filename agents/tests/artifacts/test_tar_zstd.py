import json
import tarfile
from pathlib import Path

import pytest

from sec_review_agents.artifacts.tar_zstd import (
    canonical_tar_info,
    validate_restricted_pax_archive,
)
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


def test_restricted_pax_reader_stops_at_the_entry_budget(tmp_path: Path) -> None:
    archive_path = tmp_path / "entries.tar.zst"
    first = tmp_path / "first.txt"
    second = tmp_path / "second.txt"
    first.write_text("", encoding="utf-8")
    second.write_text("", encoding="utf-8")
    with tarfile.open(archive_path, mode="w:zst", format=tarfile.PAX_FORMAT) as archive:
        archive.add(first, arcname="first.txt", filter=canonical_tar_info)
        archive.add(second, arcname="second.txt", filter=canonical_tar_info)

    with pytest.raises(ValueError, match="entry count limit"):
        validate_restricted_pax_archive(archive_path, maximum_entries=1)


def test_restricted_pax_reader_stops_at_the_extracted_byte_budget(
    tmp_path: Path,
) -> None:
    archive_path = tmp_path / "bytes.tar.zst"
    payload = tmp_path / "payload.txt"
    payload.write_text("12345", encoding="utf-8")
    with tarfile.open(archive_path, mode="w:zst", format=tarfile.PAX_FORMAT) as archive:
        archive.add(payload, arcname="payload.txt", filter=canonical_tar_info)

    with pytest.raises(ValueError, match="extracted size limit"):
        validate_restricted_pax_archive(
            archive_path,
            maximum_extracted_bytes=4,
        )
