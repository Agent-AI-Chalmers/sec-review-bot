from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.run_diagnostics.bundle import (
    DiagnosticReviewUnit,
    materialize_diagnostic_transcript_unit,
    publish_run_diagnostic_bundle,
)


def test_diagnostic_bundle_contains_artifacts_and_selects_one_review_unit(
    tmp_path: Path,
) -> None:
    artifact_root = tmp_path / "artifacts"
    first = artifact_root / "cases" / "case-a" / "transcripts"
    second = artifact_root / "cases" / "case-b" / "transcripts"
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
        publication = publish_run_diagnostic_bundle(
            run_id="run-1",
            artifact_root=artifact_root,
            review_units=[
                DiagnosticReviewUnit("case-a", first),
                DiagnosticReviewUnit("case-b", second),
            ],
            result={"review_record": {"overview": "done"}},
            remote=False,
        )
    materialized = materialize_diagnostic_transcript_unit(
        publication.reference,
        run_id="run-1",
        review_unit_id="case-b",
        destination=tmp_path / "materialized",
    )

    assert [
        path.read_text(encoding="utf-8") for path in materialized.transcript_paths
    ] == ['{"event":"other"}\n']
    assert (tmp_path / "materialized" / "artifact-tree/triage/result.json").is_file()
    assert (tmp_path / "materialized" / "result.json").read_text(
        encoding="utf-8"
    ) == '{"review_record":{"overview":"done"}}\n'


def test_diagnostic_bundle_is_byte_stable_across_retries(tmp_path: Path) -> None:
    """A retry must reuse the published archive rather than replace it."""
    artifact_root = tmp_path / "artifacts"
    transcripts = artifact_root / "transcripts"
    transcripts.mkdir(parents=True)
    (transcripts / "0001-analyzer-initial.jsonl").write_text(
        '{"event":"message"}\n', encoding="utf-8"
    )

    first = publish_run_diagnostic_bundle(
        run_id="run-1",
        artifact_root=artifact_root,
        review_units=[DiagnosticReviewUnit("review", transcripts)],
        result={"z": 1, "a": 2},
        remote=False,
    ).reference
    first_path = Path(first.uri.removeprefix("file://"))
    first_bytes = first_path.read_bytes()
    first_inode = first_path.stat().st_ino
    second = publish_run_diagnostic_bundle(
        run_id="run-1",
        artifact_root=artifact_root,
        review_units=[DiagnosticReviewUnit("review", transcripts)],
        result={"a": 2, "z": 1},
        remote=False,
    ).reference

    assert second.digest == first.digest
    assert Path(second.uri.removeprefix("file://")).read_bytes() == first_bytes
    assert first_path.stat().st_ino == first_inode


def test_diagnostic_bundle_publishes_owner_only_archive(tmp_path: Path) -> None:
    """Diagnostics contain transcripts, so the published archive stays private."""
    artifact_root = tmp_path / "artifacts"
    artifact_root.mkdir()
    (artifact_root / "result.json").write_text("{}\n", encoding="utf-8")

    reference = publish_run_diagnostic_bundle(
        run_id="run-1",
        artifact_root=artifact_root,
        review_units=[],
        result={},
        remote=False,
    ).reference

    archive = Path(reference.uri.removeprefix("file://"))
    assert archive.stat().st_mode & 0o777 == 0o600


def test_diagnostic_bundle_rejects_conflicting_existing_file(tmp_path: Path) -> None:
    """A different existing archive must fail without replacing the original."""
    artifact_root = tmp_path / "artifacts"
    artifact_root.mkdir()
    destination = artifact_root / "published" / "diagnostic-tree.v1.tar.zst"
    destination.parent.mkdir()
    destination.write_bytes(b"existing")

    with pytest.raises(RuntimeError, match="differs from immutable publication"):
        publish_run_diagnostic_bundle(
            run_id="run-1",
            artifact_root=artifact_root,
            review_units=[],
            result={"review_record": {}},
            remote=False,
        )

    assert destination.read_bytes() == b"existing"
    assert list(destination.parent.glob(".*.tmp")) == []


def test_diagnostic_bundle_build_failure_preserves_existing_file(
    tmp_path: Path,
) -> None:
    """A failed rebuild must not damage the archive already published."""
    artifact_root = tmp_path / "artifacts"
    artifact_root.mkdir()
    destination = artifact_root / "published" / "diagnostic-tree.v1.tar.zst"
    destination.parent.mkdir()
    destination.write_bytes(b"existing")

    with (
        patch(
            "sec_review_agents.run_diagnostics.bundle.tarfile.open",
            side_effect=OSError("archive failed"),
        ),
        pytest.raises(OSError, match="archive failed"),
    ):
        publish_run_diagnostic_bundle(
            run_id="run-1",
            artifact_root=artifact_root,
            review_units=[],
            result={},
            remote=False,
        )

    assert destination.read_bytes() == b"existing"
    assert list(destination.parent.glob(".*.tmp")) == []


def test_diagnostic_bundle_rejects_review_unit_path_traversal(tmp_path: Path) -> None:
    artifact_root = tmp_path / "artifacts"
    transcripts = artifact_root / "transcripts"
    transcripts.mkdir(parents=True)
    (transcripts / "0001-analyzer-initial.jsonl").write_text("{}\n", encoding="utf-8")

    with pytest.raises(ValueError, match="one path component"):
        publish_run_diagnostic_bundle(
            run_id="run-1",
            artifact_root=artifact_root,
            review_units=[DiagnosticReviewUnit("../outside", transcripts)],
            result={},
        )


def test_managed_diagnostic_bundle_requires_s3_configuration(tmp_path: Path) -> None:
    artifact_root = tmp_path / "artifacts"
    transcripts = artifact_root / "transcripts"
    transcripts.mkdir(parents=True)
    (transcripts / "0001.jsonl").write_text("{}\n", encoding="utf-8")

    with (
        patch.dict("os.environ", {}, clear=True),
        pytest.raises(RuntimeError, match="SEC_REVIEW_ARTIFACT_S3_BUCKET"),
    ):
        publish_run_diagnostic_bundle(
            run_id="run-1",
            artifact_root=artifact_root,
            review_units=[DiagnosticReviewUnit("review", transcripts)],
            result={},
        )


def test_publication_reports_only_units_included_in_manifest(tmp_path: Path) -> None:
    """Callers must not infer included units from a second filesystem scan."""
    artifact_root = tmp_path / "artifacts"
    transcripts = artifact_root / "transcripts"
    transcripts.mkdir(parents=True)
    (transcripts / "0001-real.jsonl").write_text("{}\n", encoding="utf-8")
    empty = artifact_root / "empty"
    empty.mkdir()
    (empty / "0001-fake.jsonl").mkdir()

    publication = publish_run_diagnostic_bundle(
        run_id="run-1",
        artifact_root=artifact_root,
        review_units=[
            DiagnosticReviewUnit("included", transcripts),
            DiagnosticReviewUnit("empty", empty),
        ],
        result={},
        remote=False,
    )

    assert publication.review_unit_ids == ("included",)


def test_diagnostic_bundle_can_have_no_memory_units(tmp_path: Path) -> None:
    artifact_root = tmp_path / "artifacts"
    artifact_root.mkdir()
    (artifact_root / "result.json").write_text("{}\n", encoding="utf-8")

    publication = publish_run_diagnostic_bundle(
        run_id="run-1",
        artifact_root=artifact_root,
        review_units=[],
        result={"review_record": {}},
        remote=False,
    )

    assert publication.reference.uri.endswith("/published/diagnostic-tree.v1.tar.zst")
    assert publication.review_unit_ids == ()
