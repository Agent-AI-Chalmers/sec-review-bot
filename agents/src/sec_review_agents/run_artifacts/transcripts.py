from collections.abc import Mapping
from pathlib import Path
from typing import Any

TRANSCRIPTS_DIRNAME = "transcripts"
DEFAULT_REVIEW_THREAD = "0001-review"


def _slug_component(value: str) -> str:
    slug = "".join(
        character.lower() if character.isalnum() else "-" for character in value.strip()
    ).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug or "unknown"


def review_transcripts_root(artifact_root_path: Path) -> Path:
    return artifact_root_path / TRANSCRIPTS_DIRNAME


def review_thread_dir(
    artifact_root_path: Path,
    *,
    thread_name: str = DEFAULT_REVIEW_THREAD,
) -> Path:
    return review_transcripts_root(artifact_root_path) / thread_name


def repository_case_thread_name(*, case_id: str, index: int) -> str:
    if index < 1:
        raise ValueError("Repository case transcript thread index must be >= 1.")
    return f"{index:04d}-case-{_slug_component(case_id)}"


def transcript_thread_file(
    thread_dir: Path,
    *,
    order: int,
    stage: str,
    attempt: str = "initial",
) -> Path:
    if order < 1:
        raise ValueError("Transcript order must be >= 1.")
    suffix = f"{_slug_component(stage)}-{_slug_component(attempt)}"
    return thread_dir / f"{order:04d}-{suffix}.json"


def review_stage_transcript_path(
    artifact_root_path: Path,
    *,
    order: int,
    stage: str,
    attempt: str = "initial",
    thread_name: str = DEFAULT_REVIEW_THREAD,
) -> Path:
    return transcript_thread_file(
        review_thread_dir(artifact_root_path, thread_name=thread_name),
        order=order,
        stage=stage,
        attempt=attempt,
    )


def retry_stage_order(*, stage: str, retry_context: Mapping[str, Any] | None) -> int:
    if stage == "analyzer":
        return 1
    base = 2 if stage == "mitigator" else 3 if stage == "verifier" else None
    if base is None:
        raise ValueError(f"Unsupported review transcript stage: {stage}")
    if not isinstance(retry_context, Mapping):
        return base
    retry_index = retry_context.get("retry_index")
    if not isinstance(retry_index, int) or retry_index < 1:
        return base
    return base + (retry_index * 2)


__all__ = [
    "DEFAULT_REVIEW_THREAD",
    "TRANSCRIPTS_DIRNAME",
    "repository_case_thread_name",
    "retry_stage_order",
    "review_stage_transcript_path",
    "review_thread_dir",
    "review_transcripts_root",
    "transcript_thread_file",
]
