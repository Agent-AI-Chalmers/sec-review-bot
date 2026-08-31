from pathlib import Path

import pytest

from sec_review_agents.run_artifacts.transcripts import (
    repository_case_thread_name,
    retry_stage_order,
    review_stage_transcript_path,
    review_thread_dir,
    transcript_thread_file,
)


def test_review_stage_transcript_path_uses_default_thread(tmp_path: Path) -> None:
    assert (
        review_stage_transcript_path(
            tmp_path,
            order=1,
            stage="analyzer",
        )
        == tmp_path / "transcripts" / "0001-review" / "0001-analyzer-initial.jsonl"
    )


def test_repository_case_thread_name_is_mechanical_and_slugged() -> None:
    assert repository_case_thread_name(case_id="Case 12:/A", index=2) == (
        "0002-case-case-12-a"
    )


def test_transcript_thread_file_numbers_stage_attempt(tmp_path: Path) -> None:
    assert (
        transcript_thread_file(
            review_thread_dir(tmp_path),
            order=4,
            stage="mitigator",
            attempt="retry-1",
        )
        == tmp_path / "transcripts" / "0001-review" / "0004-mitigator-retry-1.jsonl"
    )


def test_retry_stage_order_preserves_review_thread_order() -> None:
    assert retry_stage_order(stage="analyzer", retry_context=None) == 1
    assert retry_stage_order(stage="mitigator", retry_context=None) == 2
    assert retry_stage_order(stage="verifier", retry_context=None) == 3
    assert retry_stage_order(stage="mitigator", retry_context={"retry_index": 1}) == 4
    assert retry_stage_order(stage="verifier", retry_context={"retry_index": 1}) == 5


def test_retry_stage_order_rejects_unknown_stage() -> None:
    with pytest.raises(ValueError, match="Unsupported"):
        retry_stage_order(stage="cvss", retry_context=None)
