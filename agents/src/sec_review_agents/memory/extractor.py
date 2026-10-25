"""Extract durable memory observations from published review transcripts."""

import hashlib
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

from sec_review_agents.agents.memory_extractor.agent import (
    MEMORY_EXTRACTOR_AGENT_NAME,
    create_memory_extractor_agent_graph,
)
from sec_review_agents.agents.memory_extractor.backend import (
    create_memory_extractor_backend,
)
from sec_review_agents.agents.memory_extractor.prompts import (
    MEMORY_EXTRACTOR_SYSTEM_PROMPT,
    build_extractor_prompt,
)
from sec_review_agents.llm.factory import create_chat_model
from sec_review_agents.review_stages.transcripts import (
    TRANSCRIPTS_DIRNAME,
    review_transcripts_root,
)
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.runtime.transcripts import (
    TRANSCRIPT_SUFFIX,
    transcript_path,
)
from sec_review_agents.utils.files import slug_filename_component

PUBLISHED_TRANSCRIPT_STAGES = {"analyzer", "mitigator", "verifier"}


@dataclass(frozen=True)
class MemoryObservationPreviewResult:
    """Outcome of extraction before any observation is published."""

    extraction_id: str
    skipped: bool
    summary: str
    observation_markdown: str | None = None
    extractor_transcript_path: Path | None = None


def extraction_id(
    transcript_paths: list[Path],
    *,
    job_id: str | None = None,
) -> str:
    """Derive a filesystem-safe extraction ID from a job ID or transcript paths."""
    if job_id:
        return slug_filename_component(job_id, fallback="transcript")

    hasher = hashlib.sha256()
    for path in transcript_paths:
        hasher.update(str(path.expanduser().resolve()).encode("utf-8"))
        hasher.update(b"\n")
    return f"transcripts-{hasher.hexdigest()[:16]}"


def resolve_extraction_id(
    transcripts: list[tuple[str, str, Path]],
    *,
    explicit_extraction_id: str | None,
    job_id: str | None,
) -> str:
    """Resolve the final ID, giving an explicit operator value highest priority."""
    if explicit_extraction_id:
        return slug_filename_component(explicit_extraction_id, fallback="transcript")
    return extraction_id(
        [path for _stage, _attempt, path in transcripts], job_id=job_id
    )


def collect_review_memory_transcripts(
    review_artifact_root: Path,
) -> list[tuple[str, str, Path]]:
    """Collect memory-eligible transcripts from one published review artifact."""
    root = review_artifact_root.expanduser().resolve()
    return collect_published_transcripts(root)


def _published_transcript_stage_attempt(transcript: Path) -> tuple[str, str]:
    order, stage, attempt = (transcript.stem.split("-", 2) + ["", ""])[:3]
    if not order.isdecimal() or not stage or not attempt:
        raise ValueError(
            "Published transcript files must be named "
            f"<order>-<stage>-<attempt>{TRANSCRIPT_SUFFIX}: {transcript}"
        )
    return stage, attempt


def collect_published_transcripts(
    review_artifact_root: Path,
) -> list[tuple[str, str, Path]]:
    """Read the current flat ``transcripts/`` publication layout in filename order."""
    transcripts_root = review_transcripts_root(review_artifact_root)
    if not transcripts_root.is_dir():
        return []
    transcripts: list[tuple[str, str, Path]] = []
    for transcript in sorted(transcripts_root.glob(f"*{TRANSCRIPT_SUFFIX}")):
        stage, attempt = _published_transcript_stage_attempt(transcript)
        if stage not in PUBLISHED_TRANSCRIPT_STAGES:
            continue
        transcripts.append((stage, attempt, transcript))
    return transcripts


def collect_transcripts(paths: list[Path]) -> list[tuple[str, str, Path]]:
    """Resolve artifact directories or explicit transcript files without duplicates."""
    transcripts: list[tuple[str, str, Path]] = []
    seen: set[Path] = set()

    for path in paths:
        expanded = path.expanduser()
        if expanded.exists() and expanded.is_dir():
            source_refs = collect_review_memory_transcripts(path)
        else:
            if not expanded.is_file():
                raise FileNotFoundError(path)
            source_refs = [(expanded.stem, expanded.stem, expanded)]
        for stage, attempt, source in source_refs:
            resolved = source.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            transcripts.append((stage, attempt, resolved))

    return transcripts


def stage_transcripts(
    transcripts: list[tuple[str, str, Path]], destination: Path
) -> list[tuple[str, Path]]:
    """Copy transcripts into a deterministic extractor-visible sequence."""
    destination.mkdir(parents=True, exist_ok=True)
    entries: list[tuple[str, Path]] = []
    for index, (stage, attempt, source) in enumerate(transcripts, start=1):
        label = (
            slug_filename_component(stage, fallback="transcript")
            if stage == attempt
            else "-".join(
                (
                    slug_filename_component(stage, fallback="transcript"),
                    slug_filename_component(attempt, fallback="transcript"),
                )
            )
        )
        target = transcript_path(
            destination,
            name=f"{index:04d}-{label}",
        )
        shutil.copy2(source, target)
        mounted = Path("/") / TRANSCRIPTS_DIRNAME / target.name
        display = stage if stage == attempt else f"{stage} {attempt}"
        entries.append((display, mounted))

    return entries


def build_observation_document(
    *,
    source_workflow: str | None,
    run_id: str | None,
    staged_transcripts: list[tuple[str, Path]],
    observation_markdown: str,
) -> str:
    """Render one observation body with stable provenance metadata."""
    stage_labels = [label for label, _mounted in staged_transcripts]
    lines = [
        "## Provenance",
        "",
    ]
    if source_workflow:
        lines.append(f"- Source workflow: `{source_workflow}`")
    if run_id:
        lines.append(f"- Run id: `{run_id}`")
    lines.append(f"- Stages: {', '.join(stage_labels)}")
    lines.extend(
        [
            "",
            "## Observation",
            "",
        ]
    )
    return "\n".join(lines) + "\n" + observation_markdown.rstrip() + "\n"


async def _generate_memory_observation(
    transcripts: list[tuple[str, str, Path]],
    *,
    deployment: str | None,
    resolved_extraction_id: str,
    source_workflow: str | None,
    run_id: str | None,
    extractor_transcript_path: Path,
) -> MemoryObservationPreviewResult:
    with tempfile.TemporaryDirectory(prefix="sec-review-memory-extractor-") as tempdir:
        staged_transcript_root = Path(tempdir) / "transcripts"
        staged_transcripts = stage_transcripts(transcripts, staged_transcript_root)
        backend = create_memory_extractor_backend(
            transcript_root=staged_transcript_root
        )
        model = create_chat_model(
            agent_name=MEMORY_EXTRACTOR_AGENT_NAME,
            deployment_override=deployment,
        )
        async with amanaged_backend(backend):
            agent = await create_memory_extractor_agent_graph(
                model=model,
                backend=backend,
            )
            structured_result = await invoke_agent_runtime_graph(
                agent=agent,
                agent_name=MEMORY_EXTRACTOR_AGENT_NAME,
                system_prompt=MEMORY_EXTRACTOR_SYSTEM_PROMPT,
                user_prompt=build_extractor_prompt(staged_transcripts),
                transcript_paths=(extractor_transcript_path,),
            )

        observation_body = str(
            structured_result.get("observation_markdown") or ""
        ).strip()
        if not structured_result.get("has_observation") or not observation_body:
            return MemoryObservationPreviewResult(
                extraction_id=resolved_extraction_id,
                skipped=True,
                summary="No durable memory observation produced.",
                extractor_transcript_path=extractor_transcript_path,
            )

        return MemoryObservationPreviewResult(
            extraction_id=resolved_extraction_id,
            skipped=False,
            summary="Durable memory observation produced.",
            extractor_transcript_path=extractor_transcript_path,
            observation_markdown=build_observation_document(
                source_workflow=source_workflow,
                run_id=run_id,
                staged_transcripts=staged_transcripts,
                observation_markdown=observation_body,
            ),
        )


async def preview_memory_observation_from_paths(
    transcript_paths: list[Path],
    *,
    deployment: str | None = None,
    extraction_id_value: str | None = None,
    job_id: str | None = None,
    source_workflow: str | None = None,
    run_id: str | None = None,
    extractor_transcript_path: Path,
) -> MemoryObservationPreviewResult:
    """Generate an observation preview and extractor transcript from transcripts."""
    transcripts = collect_transcripts(transcript_paths)
    resolved_extraction_id = resolve_extraction_id(
        transcripts,
        explicit_extraction_id=extraction_id_value,
        job_id=job_id,
    )
    if not transcripts:
        return MemoryObservationPreviewResult(
            extraction_id=resolved_extraction_id,
            skipped=True,
            summary="No transcript files found.",
        )
    return await _generate_memory_observation(
        transcripts,
        deployment=deployment,
        resolved_extraction_id=resolved_extraction_id,
        source_workflow=source_workflow,
        run_id=run_id,
        extractor_transcript_path=extractor_transcript_path,
    )


__all__ = [
    "MemoryObservationPreviewResult",
    "build_observation_document",
    "collect_published_transcripts",
    "collect_review_memory_transcripts",
    "collect_transcripts",
    "extraction_id",
    "preview_memory_observation_from_paths",
    "resolve_extraction_id",
    "stage_transcripts",
]
