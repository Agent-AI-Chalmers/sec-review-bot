from dataclasses import replace
from pathlib import Path
from unittest.mock import patch
from urllib.parse import unquote, urlparse

import pytest

from sec_review_agents.memory.transcript_bundle import (
    TranscriptReviewUnit,
    materialize_transcript_unit,
    publish_transcript_bundle,
)


def test_transcript_bundle_round_trip_selects_one_review_unit(tmp_path: Path) -> None:
    first = tmp_path / "cases" / "case-a" / "transcripts"
    second = tmp_path / "cases" / "case-b" / "transcripts"
    first.mkdir(parents=True)
    second.mkdir(parents=True)
    (first / "0001-analyzer-initial.jsonl").write_text(
        '{"event":"message"}\n', encoding="utf-8"
    )
    (second / "0001-analyzer-initial.jsonl").write_text(
        '{"event":"other"}\n', encoding="utf-8"
    )

    with patch.dict("os.environ", {}, clear=True):
        reference = publish_transcript_bundle(
            run_id="run-1",
            artifact_root=tmp_path / "artifacts",
            review_units=[
                TranscriptReviewUnit("case-a", first),
                TranscriptReviewUnit("case-b", second),
            ],
            remote=False,
        )
    archive_path = Path(unquote(urlparse(reference.uri).path))
    with patch(
        "sec_review_agents.artifacts.reference.download_s3_input_bundle",
        return_value=archive_path,
    ):
        materialized = materialize_transcript_unit(
            replace(
                reference,
                uri="s3://artifacts/runs/run-1/transcripts/review-transcripts.v1.tar.zst",
            ),
            run_id="run-1",
            review_unit_id="case-b",
            destination=tmp_path / "materialized",
        )

    assert [
        path.read_text(encoding="utf-8") for path in materialized.transcript_paths
    ] == ['{"event":"other"}\n']


def test_transcript_bundle_rejects_review_unit_path_traversal(tmp_path: Path) -> None:
    transcripts = tmp_path / "transcripts"
    transcripts.mkdir()
    (transcripts / "0001-analyzer-initial.jsonl").write_text("{}\n", encoding="utf-8")

    with pytest.raises(ValueError, match="one path component"):
        publish_transcript_bundle(
            run_id="run-1",
            artifact_root=tmp_path / "artifacts",
            review_units=[TranscriptReviewUnit("../outside", transcripts)],
        )


def test_managed_transcript_bundle_requires_s3_configuration(tmp_path: Path) -> None:
    transcripts = tmp_path / "transcripts"
    transcripts.mkdir()
    (transcripts / "0001.jsonl").write_text("{}\n", encoding="utf-8")

    with (
        patch.dict("os.environ", {}, clear=True),
        pytest.raises(RuntimeError, match="SEC_REVIEW_ARTIFACT_S3_BUCKET"),
    ):
        publish_transcript_bundle(
            run_id="run-1",
            artifact_root=tmp_path / "artifacts",
            review_units=[TranscriptReviewUnit("review", transcripts)],
        )
