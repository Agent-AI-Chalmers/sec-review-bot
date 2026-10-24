from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.artifacts.run_diagnostic_bundle import (
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
        reference = publish_run_diagnostic_bundle(
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
        reference,
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
    )
    first_bytes = Path(first.uri.removeprefix("file://")).read_bytes()
    second = publish_run_diagnostic_bundle(
        run_id="run-1",
        artifact_root=artifact_root,
        review_units=[DiagnosticReviewUnit("review", transcripts)],
        result={"a": 2, "z": 1},
        remote=False,
    )

    assert second.digest == first.digest
    assert Path(second.uri.removeprefix("file://")).read_bytes() == first_bytes


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


def test_diagnostic_bundle_can_have_no_memory_units(tmp_path: Path) -> None:
    artifact_root = tmp_path / "artifacts"
    artifact_root.mkdir()
    (artifact_root / "result.json").write_text("{}\n", encoding="utf-8")

    reference = publish_run_diagnostic_bundle(
        run_id="run-1",
        artifact_root=artifact_root,
        review_units=[],
        result={"review_record": {}},
        remote=False,
    )

    assert reference.uri.endswith("/published/diagnostic-tree.v1.tar.zst")
