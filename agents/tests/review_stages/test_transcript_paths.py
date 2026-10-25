from pathlib import Path

from sec_review_agents.review_stages.transcripts import (
    review_transcript_path,
    review_transcripts_root,
)


def test_review_transcripts_root_uses_flat_transcripts_directory(
    tmp_path: Path,
) -> None:
    assert review_transcripts_root(tmp_path) == tmp_path / "transcripts"


def test_review_transcript_path_numbers_stage_attempt(
    tmp_path: Path,
) -> None:
    root = review_transcripts_root(tmp_path)
    assert (
        review_transcript_path(
            root,
            order=4,
            stage="mitigator",
            attempt="retry-1",
        )
        == tmp_path / "transcripts" / "0004-mitigator-retry-1.jsonl"
    )


def test_review_transcript_path_accepts_an_existing_transcripts_root(
    tmp_path: Path,
) -> None:
    root = tmp_path / "case" / "transcripts"
    assert (
        review_transcript_path(
            root,
            order=2,
            stage="verifier",
        )
        == root / "0002-verifier-initial.jsonl"
    )
