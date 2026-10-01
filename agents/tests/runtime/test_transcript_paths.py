from pathlib import Path

import pytest

from sec_review_agents.review_stages.feedback_loop import review_stage_attempt_order
from sec_review_agents.runtime.transcripts import (
    review_stage_transcript_path,
    review_transcripts_root,
    transcript_file,
)


def test_review_stage_transcript_path_uses_flat_transcripts_directory(
    tmp_path: Path,
) -> None:
    assert (
        review_stage_transcript_path(
            tmp_path,
            order=1,
            stage="analyzer",
        )
        == tmp_path / "transcripts" / "0001-analyzer-initial.json"
    )


def test_transcript_file_numbers_stage_attempt(tmp_path: Path) -> None:
    assert (
        transcript_file(
            review_transcripts_root(tmp_path),
            order=4,
            stage="mitigator",
            attempt="retry-1",
        )
        == tmp_path / "transcripts" / "0004-mitigator-retry-1.json"
    )


def test_review_stage_attempt_order_preserves_review_stage_order() -> None:
    assert review_stage_attempt_order(stage="analyzer", retry_context=None) == 1
    assert review_stage_attempt_order(stage="mitigator", retry_context=None) == 2
    assert review_stage_attempt_order(stage="verifier", retry_context=None) == 3
    assert (
        review_stage_attempt_order(stage="mitigator", retry_context={"retry_index": 1})
        == 4
    )
    assert (
        review_stage_attempt_order(stage="verifier", retry_context={"retry_index": 1})
        == 5
    )


def test_review_stage_attempt_order_rejects_unknown_stage() -> None:
    with pytest.raises(ValueError, match="Unsupported"):
        review_stage_attempt_order(stage="cvss", retry_context=None)
