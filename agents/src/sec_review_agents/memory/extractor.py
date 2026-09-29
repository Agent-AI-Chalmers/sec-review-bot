import hashlib
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

from sec_review_agents.agents.memory_extractor.agent import (
    MEMORY_EXTRACTOR_AGENT_NAME,
    create_memory_extractor_agent_graph,
)
from sec_review_agents.agents.memory_extractor.model import StagedTranscripts
from sec_review_agents.agents.memory_extractor.prompts import (
    MEMORY_EXTRACTOR_SYSTEM_PROMPT,
    build_extractor_prompt,
)
from sec_review_agents.filesystem.backend_factory import (
    create_backend_with_materials,
)
from sec_review_agents.filesystem.material_views import (
    read_only_material_view,
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
    source_workflow: str | None = None,
    run_id: str | None = None,
) -> str:
    if source_workflow and run_id:
        return "-".join(
            [
                _slug_component(source_workflow),
                _slug_component(run_id),
            ]
        )

    hasher = hashlib.sha256()
    for path in transcript_paths:
        hasher.update(str(path.expanduser().resolve()).encode("utf-8"))
        hasher.update(b"\n")
    return f"transcripts-{hasher.hexdigest()[:16]}"


def _observation_id_for_transcripts(
    transcript_refs: list[TranscriptRef],
    *,
    explicit_observation_id: str | None,
    source_workflow: str | None,
    run_id: str | None,
) -> str:
    if explicit_observation_id:
        return _slug_component(explicit_observation_id)
    if source_workflow and run_id:
        return observation_id(
            [ref.path for ref in transcript_refs],
            source_workflow=source_workflow,
            run_id=run_id,
        )
    return observation_id([ref.path for ref in transcript_refs])


def collect_review_memory_transcripts(
    review_artifact_root: Path,
) -> list[TranscriptRef]:
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
    destination.mkdir(parents=True, exist_ok=True)
    entries: list[tuple[str, Path]] = []
    for index, transcript in enumerate(transcripts, start=1):
        source = transcript.path
        target = destination / f"{index:04d}-{transcript.label}.json"
        shutil.copy2(source, target)
        mounted = Path("/transcripts") / target.name
        entries.append((transcript.display, mounted))

    return StagedTranscripts(entries=entries)


def _observation_header(
    *,
    observation_id_value: str,
    source_workflow: str | None,
    run_id: str | None,
    artifact_root_path: Path | None,
    staged_transcripts: StagedTranscripts,
) -> str:
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
    if artifact_root_path is not None:
        lines.append(
            f"- Artifact root name: `{artifact_root_path.expanduser().resolve().name}`"
        )
    lines.append(f"- Stages: {', '.join(stage_labels)}")
    lines.extend(
        [
            "",
            "## Observation",
            "",
        ]
    )
    return "\n".join(lines) + "\n"


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
    artifact_root_path: Path | None = None,
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
        backend = create_backend_with_materials(
            container_name_prefix="memory-extractor",
            material_views=[
                read_only_material_view(
                    agent_path="/transcripts",
                    host_path=transcript_root,
                ),
            ],
            use_docker_sandbox=False,
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

        observation_content = (
            _observation_header(
                observation_id_value=resolved_observation_id,
                source_workflow=source_workflow,
                run_id=run_id,
                artifact_root_path=artifact_root_path,
                staged_transcripts=staged_transcripts,
            )
            + observation_body.rstrip()
            + "\n"
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
    source_workflow: str | None = None,
    run_id: str | None = None,
    artifact_root_path: Path | None = None,
) -> MemoryObservationResult:
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
        resolved_observation_id=_observation_id_for_transcripts(
            transcript_refs,
            explicit_observation_id=observation_id_value,
            source_workflow=source_workflow,
            run_id=run_id,
        ),
        source_workflow=source_workflow,
        run_id=run_id,
        artifact_root_path=artifact_root_path,
    )
