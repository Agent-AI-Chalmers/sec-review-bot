import tarfile
from pathlib import Path

from sec_review_agents.artifacts.archive import extract_archive
from sec_review_agents.artifacts.tar_zstd import canonical_tar_info


def _write_archive(path: Path, *, filename: str, content: str) -> None:
    source = path.parent / filename
    source.write_text(content, encoding="utf-8")
    with tarfile.open(path, mode="w:zst", format=tarfile.PAX_FORMAT) as archive:
        archive.add(source, arcname=filename, filter=canonical_tar_info)
    source.unlink()


def test_extraction_uses_the_archive_opened_for_validation(tmp_path: Path) -> None:
    archive_path = tmp_path / "artifact.tar.zst"
    replacement_path = tmp_path / "replacement.tar.zst"
    _write_archive(archive_path, filename="validated.txt", content="validated")
    _write_archive(replacement_path, filename="replacement.txt", content="replacement")

    def replace_archive_path(_entries: object, _archive: tarfile.TarFile) -> None:
        archive_path.unlink()
        replacement_path.rename(archive_path)

    destination = extract_archive(
        archive_path,
        tmp_path / "extracted",
        maximum_entries=10,
        maximum_extracted_bytes=1024,
        validate_contents=replace_archive_path,
    )

    assert (destination / "validated.txt").read_text(encoding="utf-8") == "validated"
    assert not (destination / "replacement.txt").exists()
