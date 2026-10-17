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
from sec_review_agents.agents.memory_extractor.model import StagedTranscripts
from sec_review_agents.agents.memory_extractor.prompts import (
    MEMORY_EXTRACTOR_SYSTEM_PROMPT,
    build_extractor_prompt,
)
from sec_review_agents.llm.factory import create_chat_model
from sec_review_agents.memory.state import (
    OBSERVATION_STATUS_PENDING,
    OBSERVATION_STATUS_PROCESSED,
    fetch_observation_by_id,
    open_memory_state,
    upsert_observation,
)
from sec_review_agents.memory.store import (
    initialize_memory_store,
    memory_observations_dir,
    memory_store_lock,
    resolve_memory_store_dir,
)
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import amanaged_backend

PUBLISHED_TRANSCRIPT_STAGES = {"analyzer", "mitigator", "verifier"}


@dataclass(frozen=True)
class TranscriptRef:
    """A published transcript plus its review-stage provenance."""

    stage: str
    attempt: str
    path: Path

    @property
    def label(self) -> str:
        if self.stage == self.attempt:
            return _slug_component(self.stage)
        return f"{_slug_component(self.stage)}-{_slug_component(self.attempt)}"

    @property
    def display(self) -> str:
        if self.stage == self.attempt:
            return self.stage
        return f"{self.stage} {self.attempt}"


@dataclass(frozen=True)
class MemoryObservationResult:
    """Outcome of extraction, including any observation files that were published."""

    skipped: bool
    summary: str
    observation_paths: tuple[Path, ...] = ()

    @property
    def observation_path(self) -> Path | None:
        return self.observation_paths[0] if self.observation_paths else None


def _slug_component(value: str) -> str:
    slug = "".join(
        character.lower() if character.isalnum() else "-" for character in value.strip()
    ).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug or "transcript"


def observation_id(
    transcript_paths: list[Path],
    *,
    job_id: str | None = None,
) -> str:
    """Derive a filesystem-safe observation ID from a job ID or transcript paths."""
    if job_id:
        return _slug_component(job_id)

    hasher = hashlib.sha256()
    for path in transcript_paths:
        hasher.update(str(path.expanduser().resolve()).encode("utf-8"))
        hasher.update(b"\n")
    return f"transcripts-{hasher.hexdigest()[:16]}"


def resolve_observation_id(
    transcript_refs: list[TranscriptRef],
    *,
    explicit_observation_id: str | None,
    job_id: str | None,
) -> str:
    """Resolve the final ID, giving an explicit operator value highest priority."""
    if explicit_observation_id:
        return _slug_component(explicit_observation_id)
    return observation_id([ref.path for ref in transcript_refs], job_id=job_id)


def collect_review_memory_transcripts(
    review_artifact_root: Path,
) -> list[TranscriptRef]:
    """Collect memory-eligible transcripts from one published review artifact."""
    root = review_artifact_root.expanduser().resolve()
    return collect_published_transcripts(root)


def _published_transcript_stage_attempt(transcript: Path) -> tuple[str, str]:
    order, stage, attempt = (transcript.stem.split("-", 2) + ["", ""])[:3]
    if not order.isdecimal() or stage not in PUBLISHED_TRANSCRIPT_STAGES or not attempt:
        raise ValueError(
            "Published transcript files must be named "
            "<order>-<stage>-<attempt>.json with stage analyzer, mitigator, or verifier: "
            f"{transcript}"
        )
    return stage, attempt


def collect_published_transcripts(review_artifact_root: Path) -> list[TranscriptRef]:
    """Read the current flat ``transcripts/`` publication layout in filename order."""
    transcripts_root = review_artifact_root / "transcripts"
    if not transcripts_root.is_dir():
        return []
    refs: list[TranscriptRef] = []
    for transcript in sorted(transcripts_root.glob("*.json")):
        stage, attempt = _published_transcript_stage_attempt(transcript)
        refs.append(
            TranscriptRef(
                stage=stage,
                attempt=attempt,
                path=transcript,
            )
        )
    return refs


def collect_transcript_refs(paths: list[Path]) -> list[TranscriptRef]:
    """Resolve artifact directories or explicit transcript files without duplicates."""
    refs: list[TranscriptRef] = []
    seen: set[Path] = set()

    for path in paths:
        expanded = path.expanduser()
        if expanded.exists() and expanded.is_dir():
            source_refs = collect_review_memory_transcripts(path)
        else:
            if not expanded.is_file():
                raise FileNotFoundError(path)
            source_refs = [
                TranscriptRef(
                    stage=expanded.stem,
                    attempt=expanded.stem,
                    path=expanded,
                )
            ]
        for ref in source_refs:
            resolved = ref.path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            refs.append(
                TranscriptRef(
                    stage=ref.stage,
                    attempt=ref.attempt,
                    path=resolved,
                )
            )

    return refs


def stage_transcripts(
    transcripts: list[TranscriptRef], destination: Path
) -> StagedTranscripts:
    """Copy transcripts into a deterministic extractor-visible sequence."""
    destination.mkdir(parents=True, exist_ok=True)
    entries: list[tuple[str, Path]] = []
    for index, transcript in enumerate(transcripts, start=1):
        source = transcript.path
        target = destination / f"{index:04d}-{transcript.label}.json"
        shutil.copy2(source, target)
        mounted = Path("/transcripts") / target.name
        entries.append((transcript.display, mounted))

    return StagedTranscripts(entries=entries)


def build_observation_document(
    *,
    observation_id_value: str,
    source_workflow: str | None,
    run_id: str | None,
    staged_transcripts: StagedTranscripts,
    observation_markdown: str,
) -> str:
    """Render one observation body with stable provenance metadata."""
    stage_labels = [label for label, _mounted in staged_transcripts.entries]
    lines = [
        f"# Memory Observation: {observation_id_value}",
        "",
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


def _publish_observation(
    *,
    memory_root: Path,
    observation_id_value: str,
    content: str,
) -> Path:
    observations_root = memory_observations_dir(memory_root)
    observations_root.mkdir(parents=True, exist_ok=True)
    target = observations_root / f"{observation_id_value}.md"
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=observations_root,
        prefix=f".{observation_id_value}.",
        suffix=".tmp",
        delete=False,
    ) as temp_file:
        temp_path = Path(temp_file.name)
        temp_file.write(content.rstrip() + "\n")
    temp_path.replace(target)
    return target


async def _extract_memory_observation_for_refs(
    transcript_refs: list[TranscriptRef],
    *,
    memory_root: Path,
    deployment: str | None = None,
    resolved_observation_id: str,
    source_workflow: str | None = None,
    run_id: str | None = None,
) -> MemoryObservationResult:
    with open_memory_state(memory_root) as connection:
        existing = fetch_observation_by_id(connection, resolved_observation_id)
    if existing is not None and existing.status == OBSERVATION_STATUS_PROCESSED:
        return MemoryObservationResult(
            skipped=True,
            summary="Memory observation already processed; skipping.",
            observation_paths=(Path(existing.path),),
        )

    with tempfile.TemporaryDirectory(prefix="sec-review-memory-extractor-") as tempdir:
        temp_root = Path(tempdir)
        transcript_root = temp_root / "transcripts"
        staged_transcripts = stage_transcripts(transcript_refs, transcript_root)
        backend = create_memory_extractor_backend(
            transcript_root=transcript_root,
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
            )
        has_observation = bool(structured_result.get("has_observation"))
        observation_body = str(
            structured_result.get("observation_markdown") or ""
        ).strip()
        if not observation_body:
            has_observation = False
        if not has_observation:
            return MemoryObservationResult(
                skipped=True,
                summary="No durable memory observation produced.",
            )

        observation_content = build_observation_document(
            observation_id_value=resolved_observation_id,
            source_workflow=source_workflow,
            run_id=run_id,
            staged_transcripts=staged_transcripts,
            observation_markdown=observation_body,
        )

    with memory_store_lock(memory_root, exclusive=True):
        with open_memory_state(memory_root) as connection:
            existing = fetch_observation_by_id(connection, resolved_observation_id)
        if existing is not None and existing.status == OBSERVATION_STATUS_PROCESSED:
            return MemoryObservationResult(
                skipped=True,
                summary=(
                    "Memory observation was processed while extraction was running; "
                    "skipping publish."
                ),
                observation_paths=(Path(existing.path),),
            )
        observation_path = _publish_observation(
            memory_root=memory_root,
            observation_id_value=resolved_observation_id,
            content=observation_content,
        )
        with open_memory_state(memory_root) as connection:
            upsert_observation(
                connection,
                observation_id=resolved_observation_id,
                path=str(observation_path),
                status=OBSERVATION_STATUS_PENDING,
            )

    return MemoryObservationResult(
        skipped=False,
        summary=f"Memory observation written: {observation_path}",
        observation_paths=(observation_path,),
    )


async def extract_memory_observations_from_paths(
    transcript_paths: list[Path],
    *,
    memory_store_dir: Path | None = None,
    deployment: str | None = None,
    observation_id_value: str | None = None,
    job_id: str | None = None,
    source_workflow: str | None = None,
    run_id: str | None = None,
) -> MemoryObservationResult:
    """Extract and publish one pending observation from the supplied transcripts.

    This is the direct, non-Temporal entry point used by workflow activities and
    local callers. It initializes the configured store, avoids replacing an
    already processed observation, and records successful output in the ledger.
    """
    transcript_refs = collect_transcript_refs(transcript_paths)
    if not transcript_refs:
        return MemoryObservationResult(
            skipped=True,
            summary="No transcript files found.",
        )

    memory_store_dir = resolve_memory_store_dir(memory_store_dir, required=True)
    initialize_memory_store(memory_store_dir)
    return await _extract_memory_observation_for_refs(
        transcript_refs,
        memory_root=memory_store_dir,
        deployment=deployment,
        resolved_observation_id=resolve_observation_id(
            transcript_refs,
            explicit_observation_id=observation_id_value,
            job_id=job_id,
        ),
        source_workflow=source_workflow,
        run_id=run_id,
    )


__all__ = [
    "MemoryObservationResult",
    "TranscriptRef",
    "build_observation_document",
    "collect_published_transcripts",
    "collect_review_memory_transcripts",
    "collect_transcript_refs",
    "extract_memory_observations_from_paths",
    "observation_id",
    "resolve_observation_id",
    "stage_transcripts",
]
"""Extract durable memory observations from published review transcripts."""
