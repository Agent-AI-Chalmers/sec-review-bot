import json
from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.artifacts.reference import local_artifact_reference
from sec_review_agents.contract_versions import EXECUTION_ARCHIVE_ARTIFACT_VERSION
from sec_review_agents.execution_archives.bundle import (
    EXECUTION_ARCHIVE_FILENAME,
    ArchiveReviewUnit,
    materialize_archive_trajectory_unit,
    publish_execution_archive,
)
from tests.project_paths import CONTRACTS_ROOT

CORPUS = (
    CONTRACTS_ROOT
    / "tar-zstd-artifact"
    / "profiles"
    / "execution-archive"
    / EXECUTION_ARCHIVE_ARTIFACT_VERSION
    / "corpus"
)


def test_execution_archive_contains_artifacts_and_selects_one_review_unit(
    tmp_path: Path,
) -> None:
    artifact_root = tmp_path / "artifacts"
    first = artifact_root / "cases" / "case-a" / "trajectories"
    second = artifact_root / "cases" / "case-b" / "trajectories"
    first.mkdir(parents=True)
    second.mkdir(parents=True)
    (first / "0001-analyzer-initial.jsonl").write_text(
        '{"event":"message"}\n', encoding="utf-8"
    )
    (second / "0001-analyzer-initial.jsonl").write_text(
        '{"event":"other"}\n', encoding="utf-8"
    )
    (artifact_root / "triage").mkdir()
    (artifact_root / "triage" / "result.json").write_text("{}\n", encoding="utf-8")

    with patch.dict("os.environ", {}, clear=True):
        publication = publish_execution_archive(
            run_id="run-1",
            artifact_root=artifact_root,
            review_units=[
                ArchiveReviewUnit("case-a", first),
                ArchiveReviewUnit("case-b", second),
            ],
            result={"review_record": {"overview": "done"}},
            destination_scheme="file",
        )
    materialized = materialize_archive_trajectory_unit(
        publication.reference,
        run_id="run-1",
        unit_id="case-b",
        destination=tmp_path / "materialized",
    )

    assert [
        path.read_text(encoding="utf-8") for path in materialized.trajectory_paths
    ] == ['{"event":"other"}\n']
    assert (tmp_path / "materialized" / "artifact-tree/triage/result.json").is_file()
    assert (tmp_path / "materialized" / "result.json").read_text(
        encoding="utf-8"
    ) == '{"review_record":{"overview":"done"}}\n'


def test_execution_archive_is_byte_stable_across_retries(tmp_path: Path) -> None:
    """A retry must reuse the published archive rather than replace it."""
    artifact_root = tmp_path / "artifacts"
    trajectories = artifact_root / "trajectories"
    trajectories.mkdir(parents=True)
    (trajectories / "0001-analyzer-initial.jsonl").write_text(
        '{"event":"message"}\n', encoding="utf-8"
    )

    first = publish_execution_archive(
        run_id="run-1",
        artifact_root=artifact_root,
        review_units=[ArchiveReviewUnit("review", trajectories)],
        result={"z": 1, "a": 2},
        destination_scheme="file",
    ).reference
    first_path = Path(first.uri.removeprefix("file://"))
    first_bytes = first_path.read_bytes()
    first_inode = first_path.stat().st_ino
    second = publish_execution_archive(
        run_id="run-1",
        artifact_root=artifact_root,
        review_units=[ArchiveReviewUnit("review", trajectories)],
        result={"a": 2, "z": 1},
        destination_scheme="file",
    ).reference

    assert second.digest == first.digest
    assert Path(second.uri.removeprefix("file://")).read_bytes() == first_bytes
    assert first_path.stat().st_ino == first_inode


def test_execution_archive_publishes_owner_only_archive(tmp_path: Path) -> None:
    """Diagnostics contain trajectories, so the published archive stays private."""
    artifact_root = tmp_path / "artifacts"
    artifact_root.mkdir()
    (artifact_root / "result.json").write_text("{}\n", encoding="utf-8")

    reference = publish_execution_archive(
        run_id="run-1",
        artifact_root=artifact_root,
        review_units=[],
        result={},
        destination_scheme="file",
    ).reference

    archive = Path(reference.uri.removeprefix("file://"))
    assert archive.stat().st_mode & 0o777 == 0o600


def test_execution_archive_rejects_conflicting_existing_file(tmp_path: Path) -> None:
    """A different existing archive must fail without replacing the original."""
    artifact_root = tmp_path / "artifacts"
    artifact_root.mkdir()
    destination = artifact_root / "published" / EXECUTION_ARCHIVE_FILENAME
    destination.parent.mkdir()
    destination.write_bytes(b"existing")

    with pytest.raises(RuntimeError, match="differs from immutable publication"):
        publish_execution_archive(
            run_id="run-1",
            artifact_root=artifact_root,
            review_units=[],
            result={"review_record": {}},
            destination_scheme="file",
        )

    assert destination.read_bytes() == b"existing"
    assert list(destination.parent.glob(".*.tmp")) == []


def test_execution_archive_build_failure_preserves_existing_file(
    tmp_path: Path,
) -> None:
    """A failed rebuild must not damage the archive already published."""
    artifact_root = tmp_path / "artifacts"
    artifact_root.mkdir()
    destination = artifact_root / "published" / EXECUTION_ARCHIVE_FILENAME
    destination.parent.mkdir()
    destination.write_bytes(b"existing")

    with (
        patch(
            "sec_review_agents.execution_archives.bundle.tarfile.open",
            side_effect=OSError("archive failed"),
        ),
        pytest.raises(OSError, match="archive failed"),
    ):
        publish_execution_archive(
            run_id="run-1",
            artifact_root=artifact_root,
            review_units=[],
            result={},
            destination_scheme="file",
        )

    assert destination.read_bytes() == b"existing"
    assert list(destination.parent.glob(".*.tmp")) == []


def test_execution_archive_rejects_review_unit_path_traversal(tmp_path: Path) -> None:
    artifact_root = tmp_path / "artifacts"
    trajectories = artifact_root / "trajectories"
    trajectories.mkdir(parents=True)
    (trajectories / "0001-analyzer-initial.jsonl").write_text("{}\n", encoding="utf-8")

    with pytest.raises(ValueError, match="one path component"):
        publish_execution_archive(
            run_id="run-1",
            artifact_root=artifact_root,
            review_units=[ArchiveReviewUnit("../outside", trajectories)],
            result={},
        )


def test_s3_execution_archive_requires_s3_configuration(
    tmp_path: Path,
) -> None:
    artifact_root = tmp_path / "artifacts"
    trajectories = artifact_root / "trajectories"
    trajectories.mkdir(parents=True)
    (trajectories / "0001.jsonl").write_text("{}\n", encoding="utf-8")

    with (
        patch.dict("os.environ", {}, clear=True),
        pytest.raises(RuntimeError, match="SEC_REVIEW_ARTIFACT_S3_BUCKET"),
    ):
        publish_execution_archive(
            run_id="run-1",
            artifact_root=artifact_root,
            review_units=[ArchiveReviewUnit("review", trajectories)],
            result={},
        )


def test_execution_archive_rejects_unknown_destination_scheme(tmp_path: Path) -> None:
    artifact_root = tmp_path / "artifacts"
    artifact_root.mkdir()

    with pytest.raises(ValueError, match="Unsupported execution archive scheme"):
        publish_execution_archive(
            run_id="run-1",
            artifact_root=artifact_root,
            review_units=[],
            result={},
            destination_scheme="https",  # type: ignore[arg-type]
        )

    assert not (artifact_root / "published").exists()


def test_publication_reports_only_units_included_in_manifest(tmp_path: Path) -> None:
    """Callers must not infer included units from a second filesystem scan."""
    artifact_root = tmp_path / "artifacts"
    trajectories = artifact_root / "trajectories"
    trajectories.mkdir(parents=True)
    (trajectories / "0001-real.jsonl").write_text("{}\n", encoding="utf-8")
    empty = artifact_root / "empty"
    empty.mkdir()
    (empty / "0001-fake.jsonl").mkdir()

    publication = publish_execution_archive(
        run_id="run-1",
        artifact_root=artifact_root,
        review_units=[
            ArchiveReviewUnit("included", trajectories),
            ArchiveReviewUnit("empty", empty),
        ],
        result={},
        destination_scheme="file",
    )

    assert publication.unit_ids == ("included",)


def test_execution_archive_can_have_no_memory_units(tmp_path: Path) -> None:
    artifact_root = tmp_path / "artifacts"
    artifact_root.mkdir()
    (artifact_root / "result.json").write_text("{}\n", encoding="utf-8")

    publication = publish_execution_archive(
        run_id="run-1",
        artifact_root=artifact_root,
        review_units=[],
        result={"review_record": {}},
        destination_scheme="file",
    )

    assert publication.reference.uri.endswith(
        f"/published/{EXECUTION_ARCHIVE_FILENAME}"
    )
    assert publication.unit_ids == ()


def test_execution_archive_rejects_too_many_entries(tmp_path: Path) -> None:
    artifact_root = tmp_path / "artifacts"
    artifact_root.mkdir()
    (artifact_root / "one.txt").write_text("one", encoding="utf-8")

    with (
        patch(
            "sec_review_agents.execution_archives.bundle.MAX_EXECUTION_ARCHIVE_ENTRIES",
            3,
        ),
        pytest.raises(ValueError, match="entry count limit"),
    ):
        publish_execution_archive(
            run_id="run-1",
            artifact_root=artifact_root,
            review_units=[],
            result={},
            destination_scheme="file",
        )


def test_execution_archive_rejects_too_many_extracted_bytes(tmp_path: Path) -> None:
    artifact_root = tmp_path / "artifacts"
    artifact_root.mkdir()
    (artifact_root / "large.txt").write_bytes(b"large")

    with (
        patch(
            "sec_review_agents.execution_archives.bundle.MAX_EXTRACTED_ARCHIVE_BYTES",
            1,
        ),
        pytest.raises(ValueError, match="extracted size limit"),
    ):
        publish_execution_archive(
            run_id="run-1",
            artifact_root=artifact_root,
            review_units=[],
            result={},
            destination_scheme="file",
        )


def test_execution_archive_rejects_too_many_compressed_bytes(tmp_path: Path) -> None:
    artifact_root = tmp_path / "artifacts"
    artifact_root.mkdir()

    with (
        patch(
            "sec_review_agents.execution_archives.bundle.MAX_EXECUTION_ARCHIVE_BYTES",
            1,
        ),
        pytest.raises(ValueError, match="compressed size limit"),
    ):
        publish_execution_archive(
            run_id="run-1",
            artifact_root=artifact_root,
            review_units=[],
            result={},
            destination_scheme="file",
        )

    assert not (artifact_root / "published" / EXECUTION_ARCHIVE_FILENAME).exists()


def test_python_reader_matches_shared_execution_archive_corpus(tmp_path: Path) -> None:
    manifest = json.loads((CORPUS / "manifest.json").read_text(encoding="utf-8"))

    for case in manifest["corpus"]:
        archive = CORPUS / case["file"]
        run_id = case["runId"]
        unit_id = case["unitId"]
        destination = tmp_path / case["file"]

        if case["expected"] == "valid":
            result = materialize_archive_trajectory_unit(
                local_artifact_reference(archive),
                run_id=run_id,
                unit_id=unit_id,
                destination=destination,
            )
            assert result.trajectory_paths
        else:
            with pytest.raises(ValueError):
                materialize_archive_trajectory_unit(
                    local_artifact_reference(archive),
                    run_id=run_id,
                    unit_id=unit_id,
                    destination=destination,
                )
