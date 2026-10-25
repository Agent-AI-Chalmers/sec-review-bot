"""Review-stage transcript layout."""

from pathlib import Path

from sec_review_agents.runtime import transcripts
from sec_review_agents.utils.files import slug_filename_component

TRANSCRIPTS_DIRNAME = "transcripts"


def review_transcripts_root(artifact_root_path: Path) -> Path:
    return artifact_root_path / TRANSCRIPTS_DIRNAME


def review_transcript_path(
    transcripts_root: Path,
    *,
    order: int,
    stage: str,
    attempt: str = "initial",
) -> Path:
    if order < 1:
        raise ValueError("Transcript order must be >= 1.")
    suffix = "-".join(
        (
            slug_filename_component(stage, fallback="unknown"),
            slug_filename_component(attempt, fallback="unknown"),
        )
    )
    return transcripts.transcript_path(
        transcripts_root,
        name=f"{order:04d}-{suffix}",
    )


__all__ = [
    "TRANSCRIPTS_DIRNAME",
    "review_transcript_path",
    "review_transcripts_root",
]
