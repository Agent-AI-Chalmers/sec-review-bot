import hashlib
import os
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Literal

from langchain_core.messages.utils import count_tokens_approximately

from sec_review_agents.agents.discovery.model import (
    DiscoveryCandidate,
    DiscoveryLocation,
)
from sec_review_agents.agents.discovery.prompts import (
    build_repository_discovery_system_prompt,
    build_repository_discovery_user_prompt,
)
from sec_review_agents.runtime.deployment_limits import (
    resolve_bound_deployment_max_input_tokens,
)
from sec_review_agents.scan_stages.discovery.execution import (
    run_repository_discovery_agent,
)
from sec_review_agents.scan_stages.discovery.input import (
    DiscoveryChunk,
    DiscoveryEntry,
    DiscoveryManifest,
    DiscoverySkippedFile,
)
from sec_review_agents.scan_stages.discovery.result import (
    DiscoveryCandidateResult,
    DiscoveryChunkResult,
    DiscoveryCounts,
    DiscoveryFileResult,
    DiscoveryMetadata,
    DiscoveryResult,
)
from sec_review_agents.utils.env import int_env
from sec_review_agents.utils.files import persist_json_artifact, remove_json_artifacts
from sec_review_agents.utils.paths_ignore import (
    matches_paths_ignore,
    normalize_paths_ignore,
)

#########################################################################
# ====================== File Filtering And Discovery Limits ============
#########################################################################
INCLUDED_CODE_EXTENSIONS = {
    ".c",
    ".cc",
    ".cpp",
    ".cs",
    ".go",
    ".h",
    ".hpp",
    ".java",
    ".js",
    ".jsx",
    ".php",
    ".py",
    ".rb",
    ".rs",
    ".sh",
    ".ts",
    ".tsx",
}
TEXT_LIKE_EXTENSIONS = {
    ".cfg",
    ".conf",
    ".csv",
    ".env",
    ".htm",
    ".html",
    ".ini",
    ".json",
    ".log",
    ".md",
    ".rst",
    ".sql",
    ".text",
    ".tf",
    ".toml",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}
# Discovery is intentionally denylist-based: unknown and uncommon source formats
# remain scannable, while kinds that are clearly prose or tabular output do not
# consume an initial model call without evidence linking them to code behavior.
EXCLUDED_DISCOVERY_EXTENSIONS = {
    ".csv",
    ".log",
    ".md",
    ".rst",
    ".text",
    ".tsv",
    ".txt",
}
EXCLUDED_DIR_NAMES = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    ".yarn",
    ".next",
    "__pycache__",
    "artifacts",
    "build",
    "cache",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "tmp",
    "vendor",
}
DEFAULT_DISCOVERY_MAX_CONCURRENCY = 1
DEFAULT_DISCOVERY_CHUNK_STRATEGY = "single-file"
# This is a host-side safety limit for bounded reads and prompt preparation. It
# is independent of the deployment token limits that decide model input fit.
DEFAULT_DISCOVERY_MAX_FILE_BYTES = 262_144
GROUNDED_STATUS: Literal["grounded"] = "grounded"
NEEDS_GROUNDING_STATUS: Literal["needs-grounding"] = "needs-grounding"


def read_utf8_text_file(path: Path) -> str | None:
    """Read a UTF-8 text file, returning None when it is unreadable or binary."""
    # Callers can treat unreadable files as per-file skips instead of failing a
    # broader scan or batch.
    try:
        content = path.read_text(encoding="utf-8")
    except OSError, UnicodeDecodeError:
        return None

    if "\x00" in content:
        return None

    return content


#########################################################################
# ====================== Scan Manifest Construction ======================
#########################################################################
def _path_language(file_path: Path) -> str:
    filename = file_path.name
    suffix = file_path.suffix.lower()
    if filename in {"Dockerfile", "docker-compose.yml", "docker-compose.yaml"}:
        return "config"
    if suffix == ".py":
        return "python"
    if suffix in {".js", ".jsx"}:
        return "javascript"
    if suffix in {".ts", ".tsx"}:
        return "typescript"
    if suffix in {".yaml", ".yml", ".json", ".toml", ".ini", ".conf", ".tf", ".env"}:
        return "config"
    if suffix in TEXT_LIKE_EXTENSIONS:
        return "text"
    if suffix == ".sh":
        return "shell"
    if suffix in INCLUDED_CODE_EXTENSIONS:
        return "code"
    return "text"


def _classify_candidate_file(relative_path: Path) -> tuple[bool, str, str]:
    parts = relative_path.parts
    if any(part in EXCLUDED_DIR_NAMES for part in parts[:-1]):
        return False, "excluded-directory", _path_language(relative_path)
    if relative_path.suffix.lower() in EXCLUDED_DISCOVERY_EXTENSIONS:
        return False, "excluded-discovery-kind", _path_language(relative_path)
    return True, "text-candidate", _path_language(relative_path)


def _resolve_discovery_max_file_bytes() -> tuple[int, str]:
    env_max_file_bytes = int_env("AGENT_DISCOVERY_MAX_FILE_BYTES", None, minimum=0)

    if env_max_file_bytes is not None:
        return env_max_file_bytes, "AGENT_DISCOVERY_MAX_FILE_BYTES"
    return DEFAULT_DISCOVERY_MAX_FILE_BYTES, "default"


def _resolve_discovery_chunk_strategy() -> str:
    strategy = (
        os.environ.get(
            "AGENT_DISCOVERY_CHUNK_STRATEGY", DEFAULT_DISCOVERY_CHUNK_STRATEGY
        )
        .strip()
        .lower()
    )
    if strategy not in {"batched", "single-file"}:
        raise ValueError(
            "AGENT_DISCOVERY_CHUNK_STRATEGY must be 'batched' or 'single-file'."
        )
    return strategy


def _build_scan_manifest(
    *,
    workspace_root: Path,
    scan_scope: dict[str, Any],
    discovery_artifacts_path: Path,
) -> tuple[list[DiscoveryEntry], list[DiscoverySkippedFile]]:
    max_file_bytes, max_file_bytes_source = _resolve_discovery_max_file_bytes()
    paths_ignore = normalize_paths_ignore(
        scan_scope.get("paths_ignore"), source="Repository discovery"
    )
    entries: list[DiscoveryEntry] = []
    skipped: list[DiscoverySkippedFile] = []

    for current_root, dir_names, file_names in os.walk(workspace_root):
        dir_names[:] = [name for name in dir_names if name not in EXCLUDED_DIR_NAMES]
        root_path = Path(current_root)

        for file_name in sorted(file_names):
            absolute_path = root_path / file_name
            relative_path = absolute_path.relative_to(workspace_root)
            relative_path_text = relative_path.as_posix()
            include_file, include_reason, language = _classify_candidate_file(
                relative_path
            )
            size_bytes = absolute_path.stat().st_size

            if matches_paths_ignore(relative_path, paths_ignore):
                skipped.append(
                    DiscoverySkippedFile(
                        path=relative_path_text,
                        reason="paths-ignore",
                        size_bytes=size_bytes,
                    )
                )
                continue
            if not include_file:
                skipped.append(
                    DiscoverySkippedFile(
                        path=relative_path_text,
                        reason=include_reason,
                        size_bytes=size_bytes,
                    )
                )
                continue
            if max_file_bytes > 0 and size_bytes > max_file_bytes:
                skipped.append(
                    DiscoverySkippedFile(
                        path=relative_path_text,
                        reason="oversized",
                        size_bytes=size_bytes,
                    )
                )
                continue
            if read_utf8_text_file(absolute_path) is None:
                skipped.append(
                    DiscoverySkippedFile(
                        path=relative_path_text,
                        reason="binary-or-unreadable",
                        size_bytes=size_bytes,
                    )
                )
                continue

            entries.append(
                DiscoveryEntry(
                    path=relative_path_text,
                    size_bytes=size_bytes,
                    language=language,
                    include_reason=include_reason,
                )
            )

    entries.sort(key=lambda item: item.path)
    skipped.sort(key=lambda item: item.path)

    manifest = {
        "metadata": {
            "max_file_bytes": max_file_bytes,
            "max_file_bytes_source": max_file_bytes_source,
            "paths_ignore": paths_ignore,
        },
        "counts": {
            "scannable_file_count": len(entries),
            "skipped_file_count": len(skipped),
        },
        "files": [entry.model_dump() for entry in entries],
        "skipped_files": [item.model_dump(exclude_none=True) for item in skipped],
    }
    persist_json_artifact(
        discovery_artifacts_path,
        "scan-manifest",
        manifest,
    )
    return entries, skipped


# The scan scope's change vocabulary, mirroring `changedFileStatus` in the Execution API.
# `deleted` is the only status that removes a file from discovery; the rest describe how a file
# changed and all of them are scanned.
INCREMENTAL_CHANGED_FILE_STATUSES = frozenset(
    {"added", "modified", "deleted", "renamed", "copied", "type_changed"}
)


def _load_incremental_changed_files(
    scan_scope: dict[str, Any],
) -> list[dict[str, Any]]:
    raw_files = scan_scope.get("incremental_changed_files")
    if isinstance(raw_files, list):
        normalized: list[dict[str, Any]] = []
        for index, item in enumerate(raw_files):
            if not isinstance(item, dict):
                raise ValueError(
                    "Repository incremental discovery requires "
                    "scan_scope.incremental_changed_files"
                    f"[{index}] to be an object."
                )
            file_path = str(item.get("path") or "").strip()
            if not file_path:
                raise ValueError(
                    "Repository incremental discovery requires "
                    "scan_scope.incremental_changed_files"
                    f"[{index}].path to be non-empty."
                )
            status = str(item.get("status") or "").strip().lower()
            if not status:
                raise ValueError(
                    "Repository incremental discovery requires "
                    "scan_scope.incremental_changed_files"
                    f"[{index}].status to be non-empty."
                )
            previous_path = item.get("previous_path")
            if previous_path is not None and not isinstance(previous_path, str):
                raise ValueError(
                    "Repository incremental discovery requires "
                    "scan_scope.incremental_changed_files"
                    f"[{index}].previous_path to be a string or null."
                )
            normalized.append(
                {
                    "path": file_path.replace("\\", "/"),
                    "status": status,
                    "previous_path": (
                        previous_path.strip()
                        if isinstance(previous_path, str) and previous_path.strip()
                        else None
                    ),
                }
            )
        return normalized

    raise ValueError(
        "Repository incremental discovery requires scan_scope.incremental_changed_files."
    )


def _entry_from_incremental_record(
    *,
    root: Path,
    path_value: Path,
    max_file_bytes: int,
    paths_ignore: list[str],
) -> tuple[DiscoveryEntry | None, DiscoverySkippedFile | None]:
    normalized_path = path_value.as_posix()
    include_file, include_reason, language = _classify_candidate_file(path_value)
    absolute_path = root / path_value
    exists_now = absolute_path.exists()
    size_bytes = absolute_path.stat().st_size if exists_now else 0

    if matches_paths_ignore(path_value, paths_ignore):
        return None, DiscoverySkippedFile(
            path=normalized_path,
            reason="paths-ignore",
            size_bytes=size_bytes,
        )
    if not include_file:
        return None, DiscoverySkippedFile(
            path=normalized_path,
            reason=include_reason,
            size_bytes=size_bytes,
        )
    if not exists_now:
        return None, DiscoverySkippedFile(
            path=normalized_path,
            reason="missing-from-workspace",
            size_bytes=0,
        )
    if max_file_bytes > 0 and size_bytes > max_file_bytes:
        return None, DiscoverySkippedFile(
            path=normalized_path,
            reason="oversized",
            size_bytes=size_bytes,
        )
    if read_utf8_text_file(absolute_path) is None:
        return None, DiscoverySkippedFile(
            path=normalized_path,
            reason="binary-or-unreadable",
            size_bytes=size_bytes,
        )

    return (
        DiscoveryEntry(
            path=normalized_path,
            size_bytes=size_bytes,
            language=language,
            include_reason=include_reason,
        ),
        None,
    )


def _build_incremental_scan_manifest(
    *,
    workspace_root: Path,
    scan_scope: dict[str, Any],
    changed_files: Sequence[Mapping[str, Any]],
    discovery_artifacts_path: Path,
) -> tuple[list[DiscoveryEntry], list[DiscoverySkippedFile]]:
    max_file_bytes, max_file_bytes_source = _resolve_discovery_max_file_bytes()
    paths_ignore = normalize_paths_ignore(
        scan_scope.get("paths_ignore"), source="Repository discovery"
    )

    entries: list[DiscoveryEntry] = []
    skipped: list[DiscoverySkippedFile] = []
    seen_paths: set[str] = set()

    for item in changed_files:
        current_path = str(item.get("path") or "").strip()
        if not current_path:
            raise ValueError(
                "Repository incremental discovery received an empty changed-file path."
            )
        normalized_path = Path(current_path.replace("\\", "/"))
        normalized_path_text = normalized_path.as_posix()
        if normalized_path_text in seen_paths:
            continue
        seen_paths.add(normalized_path_text)
        status = str(item.get("status") or "").strip().lower()
        if status not in INCREMENTAL_CHANGED_FILE_STATUSES:
            # A status outside the contract means the producer and this consumer disagree about
            # the vocabulary. Skipping it (or scanning it) would silently change which files are
            # analyzed, so the disagreement has to stop the run.
            raise ValueError(
                "Repository incremental discovery received an unsupported changed-file status "
                f"{status!r}; expected one of {sorted(INCREMENTAL_CHANGED_FILE_STATUSES)}."
            )
        if status == "deleted":
            continue

        entry, skip = _entry_from_incremental_record(
            root=workspace_root,
            path_value=normalized_path,
            max_file_bytes=max_file_bytes,
            paths_ignore=paths_ignore,
        )
        if entry is not None:
            entries.append(entry)
        if skip is not None:
            skipped.append(skip)

    entries.sort(key=lambda item: item.path)
    skipped.sort(key=lambda item: item.path)

    manifest = {
        "metadata": {
            "max_file_bytes": max_file_bytes,
            "max_file_bytes_source": max_file_bytes_source,
            "paths_ignore": paths_ignore,
        },
        "counts": {
            "scannable_file_count": len(entries),
            "skipped_file_count": len(skipped),
        },
        "files": [entry.model_dump() for entry in entries],
        "skipped_files": [item.model_dump(exclude_none=True) for item in skipped],
    }
    persist_json_artifact(
        discovery_artifacts_path,
        "scan-manifest",
        manifest,
    )
    return entries, skipped


#########################################################################
# ====================== Candidate Normalization And Grounding ===========
#########################################################################
def _candidate_id(
    file_path: str, category: str, line_number: int, description: str
) -> str:
    payload = f"{file_path}:{category}:{line_number}:{description}"
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def _line_number_for_snippet(
    content: str, snippet: str, fallback: int | None = None
) -> int | None:
    normalized = snippet.strip()
    if not normalized:
        return fallback

    index = content.find(normalized)
    if index != -1:
        return content.count("\n", 0, index) + 1
    return fallback


def _grounded_evidence_by_file(
    content_by_path: dict[str, str], evidence_items: list[str]
) -> tuple[list[str], dict[str, str]]:
    grounded: list[str] = []
    evidence_files: dict[str, str] = {}
    for item in evidence_items:
        for path, content in content_by_path.items():
            if _line_number_for_snippet(content, item, fallback=None) is None:
                continue
            grounded.append(item)
            evidence_files[item] = path
            break
    return grounded, evidence_files


def _evidence_location_label(evidence_item: str) -> str:
    first_line = str(evidence_item or "").strip().splitlines()[0].strip()
    return first_line[:120] if first_line else "evidence"


def _normalize_candidate(
    content_by_path: dict[str, str],
    candidate: DiscoveryCandidate,
) -> DiscoveryCandidate | None:
    """Filter source references and recover a location from matching evidence.

    Return new candidate content, or discard candidates with neither signal.
    Identity and grounding status belong to stage result assembly.
    """
    normalized_locations: list[DiscoveryLocation] = []
    for location in candidate.locations:
        file = location.file.lstrip("/")
        if file not in content_by_path:
            continue
        line_count = len(content_by_path[file].splitlines()) or 1
        if location.line is not None and location.line > line_count:
            continue
        normalized_locations.append(
            DiscoveryLocation(file=file, label=location.label, line=location.line)
        )

    grounded_evidence_items, evidence_files = _grounded_evidence_by_file(
        content_by_path, candidate.evidence
    )
    if not normalized_locations and grounded_evidence_items:
        evidence_file = evidence_files[grounded_evidence_items[0]]
        grounded_line = _line_number_for_snippet(
            content_by_path[evidence_file], grounded_evidence_items[0], fallback=None
        )
        if grounded_line is not None:
            normalized_locations.append(
                DiscoveryLocation(
                    file=evidence_file,
                    line=grounded_line,
                    label=_evidence_location_label(grounded_evidence_items[0]),
                )
            )

    # Structural constraint: drop candidates that have no verifiable anchor signal at all.
    # We require at least one valid location or one verbatim evidence snippet grounded in file content.
    if not normalized_locations and not grounded_evidence_items:
        return None

    return DiscoveryCandidate(
        category=candidate.category,
        description=candidate.description,
        locations=normalized_locations,
        evidence=grounded_evidence_items,
    )


#########################################################################
# ====================== Chunked LLM Scan Execution ======================
#########################################################################
def discovery_chunk_token_limits(
    target_ratio: tuple[int, int] = (1, 5),
) -> tuple[int, int, int]:
    # Limit the initial repository payload to 20% of the model input window.
    # The remaining context absorbs tokenizer error, runtime-added schemas and
    # skill guidance, tool turns, and the attention loss seen in very long inputs.
    deployment_limit_tokens = resolve_bound_deployment_max_input_tokens(
        "repository-discovery"
    )
    numerator, denominator = target_ratio
    if numerator <= 0 or denominator <= 0 or numerator * 5 > denominator * 4:
        raise ValueError("Discovery chunk target ratio must be between 0 and 4/5.")
    target_tokens = deployment_limit_tokens * numerator // denominator
    # Keep room for runtime-added schemas, skills, tool turns, and tokenizer
    # estimation error when admitting a large single-file payload.
    hard_limit_tokens = deployment_limit_tokens * 4 // 5
    system_prompt_tokens = count_tokens_approximately(
        [
            {
                "role": "system",
                "content": build_repository_discovery_system_prompt(),
            }
        ]
    )
    if target_tokens <= system_prompt_tokens:
        raise ValueError(
            "Repository discovery requires the selected chunk target to exceed "
            "the discovery system prompt size."
        )
    return deployment_limit_tokens, target_tokens, hard_limit_tokens


def _estimate_discovery_prompt_tokens(
    *, chunk_id: str, entries: Sequence[DiscoveryEntry], sources: dict[str, str]
) -> int:
    user_prompt = build_repository_discovery_user_prompt(
        chunk_id=chunk_id,
        entries=entries,
        sources=sources,
    )
    return count_tokens_approximately(
        [
            {
                "role": "system",
                "content": build_repository_discovery_system_prompt(),
            },
            {
                "role": "user",
                "content": user_prompt,
            },
        ]
    )


def _pack_discovery_chunks(
    *,
    entries: Sequence[DiscoveryEntry],
    root: Path,
    target_tokens: int,
    hard_limit_tokens: int,
    strategy: str = DEFAULT_DISCOVERY_CHUNK_STRATEGY,
) -> tuple[list[DiscoveryChunk], list[DiscoverySkippedFile]]:
    chunks: list[DiscoveryChunk] = []
    skipped: list[DiscoverySkippedFile] = []
    current_entries: list[DiscoveryEntry] = []
    current_sources: dict[str, str] = {}
    current_tokens = 0

    def emit_current() -> None:
        nonlocal current_entries, current_sources, current_tokens
        if not current_entries:
            return
        chunks.append(
            DiscoveryChunk(
                chunk_id=f"discovery-chunk-{len(chunks) + 1:04d}",
                entries=list(current_entries),
                token_count=current_tokens,
            )
        )
        current_entries = []
        current_sources = {}
        current_tokens = 0

    for entry in entries:
        path = entry.path
        content = read_utf8_text_file(root / path)
        if content is None:
            skipped.append(
                DiscoverySkippedFile(
                    path=path,
                    reason="binary-or-unreadable",
                    size_bytes=entry.size_bytes,
                )
            )
            continue

        if strategy == "single-file":
            candidate_tokens = _estimate_discovery_prompt_tokens(
                chunk_id=f"discovery-chunk-{len(chunks) + 1:04d}",
                entries=[entry],
                sources={path: content},
            )
            if candidate_tokens > hard_limit_tokens:
                skipped.append(
                    DiscoverySkippedFile(
                        path=path,
                        reason="token-budget-exceeded",
                        size_bytes=entry.size_bytes,
                        token_count=candidate_tokens,
                        hard_limit_tokens=hard_limit_tokens,
                    )
                )
                continue
            chunks.append(
                DiscoveryChunk(
                    chunk_id=f"discovery-chunk-{len(chunks) + 1:04d}",
                    entries=[entry.model_copy()],
                    token_count=candidate_tokens,
                )
            )
            continue

        chunk_id = f"discovery-chunk-{len(chunks) + 1:04d}"
        candidate_entries = [*current_entries, entry]
        candidate_sources = {**current_sources, path: content}
        candidate_tokens = _estimate_discovery_prompt_tokens(
            chunk_id=chunk_id,
            entries=candidate_entries,
            sources=candidate_sources,
        )
        if current_entries and candidate_tokens > target_tokens:
            emit_current()
            chunk_id = f"discovery-chunk-{len(chunks) + 1:04d}"
            candidate_entries = [entry]
            candidate_sources = {path: content}
            candidate_tokens = _estimate_discovery_prompt_tokens(
                chunk_id=chunk_id,
                entries=candidate_entries,
                sources=candidate_sources,
            )
        # The target controls ordinary multi-file chunk size. A complete single
        # file may exceed it; only the deployment input limit makes it unscannable.
        if not current_entries and candidate_tokens > hard_limit_tokens:
            skipped.append(
                DiscoverySkippedFile(
                    path=path,
                    reason="token-budget-exceeded",
                    size_bytes=entry.size_bytes,
                    token_count=candidate_tokens,
                    hard_limit_tokens=hard_limit_tokens,
                )
            )
            continue
        current_entries = [item.model_copy() for item in candidate_entries]
        current_sources = candidate_sources
        current_tokens = candidate_tokens
        if current_tokens >= target_tokens:
            emit_current()

    emit_current()
    return chunks, skipped


def _resolve_discovery_max_concurrency(entry_count: int) -> int:
    configured = int_env(
        "AGENT_DISCOVERY_MAX_CONCURRENCY",
        DEFAULT_DISCOVERY_MAX_CONCURRENCY,
        minimum=1,
    )
    if entry_count <= 0:
        return 1
    return min(configured, entry_count)


async def scan_discovery_chunk(
    *,
    chunk: DiscoveryChunk,
    root: Path,
    discovery_artifacts_path: Path | None = None,
) -> DiscoveryChunkResult:
    entries = chunk.entries
    sources: dict[str, str] = {}
    skipped_files: list[DiscoverySkippedFile] = []

    for entry in entries:
        path = entry.path
        content = read_utf8_text_file(root / path)
        if content is None:
            skipped_files.append(
                DiscoverySkippedFile(
                    path=path,
                    reason="binary-or-unreadable",
                    size_bytes=entry.size_bytes,
                )
            )
            continue
        sources[path] = content

    if not sources:
        return DiscoveryChunkResult(
            chunk_id=chunk.chunk_id,
            file_candidates=[],
            file_results=[],
            skipped_files=skipped_files,
        )

    discovery_run = await run_repository_discovery_agent(
        chunk=chunk,
        sources=sources,
        discovery_artifacts_path=discovery_artifacts_path,
    )
    candidates_by_file: dict[str, list[DiscoveryCandidateResult]] = {
        path: [] for path in sources
    }
    all_candidates: list[DiscoveryCandidateResult] = []
    for item in discovery_run.candidates:
        normalized = _normalize_candidate(sources, item)
        if normalized is None:
            continue
        primary = normalized.locations[0] if normalized.locations else None
        candidate = DiscoveryCandidateResult(
            candidate_id=_candidate_id(
                primary.file if primary else next(iter(sources)),
                normalized.category,
                (primary.line or 0) if primary else 0,
                normalized.description,
            ),
            candidate=normalized,
            grounding_status=(
                GROUNDED_STATUS
                if normalized.locations and normalized.evidence
                else NEEDS_GROUNDING_STATUS
            ),
        )
        all_candidates.append(candidate)
        candidate_files = {
            location.file
            for location in candidate.candidate.locations
            if location.file in sources
        }
        for path in candidate_files or {next(iter(sources))}:
            candidates_by_file.setdefault(path, []).append(candidate)

    file_results: list[DiscoveryFileResult] = []
    for entry in entries:
        path = entry.path
        if path not in sources:
            continue
        file_results.append(
            DiscoveryFileResult(
                path=path,
                language=entry.language,
                size_bytes=entry.size_bytes,
                candidate_count=len(candidates_by_file.get(path, [])),
            )
        )

    return DiscoveryChunkResult(
        chunk_id=chunk.chunk_id,
        file_candidates=all_candidates,
        file_results=file_results,
        skipped_files=skipped_files,
    )


def build_discovery_result_from_chunks(
    *,
    entries: Sequence[DiscoveryEntry],
    skipped_files: Sequence[DiscoverySkippedFile],
    chunks: Sequence[DiscoveryChunk],
    chunk_results: Sequence[DiscoveryChunkResult],
    scan_mode: str,
    deployment_input_limit_tokens: int,
    chunk_target_tokens: int,
    chunk_target_ratio: str,
    chunk_hard_limit_tokens: int,
    discovery_concurrency: int,
    chunk_strategy: str = DEFAULT_DISCOVERY_CHUNK_STRATEGY,
) -> DiscoveryResult:
    """Combine ordered chunk outcomes into the stage result without side effects."""
    candidates: list[DiscoveryCandidateResult] = []
    file_results: list[DiscoveryFileResult] = []
    all_skipped_files = list(skipped_files)

    for scan_result in chunk_results:
        all_skipped_files.extend(scan_result.skipped_files)
        candidates.extend(scan_result.file_candidates)
        file_results.extend(scan_result.file_results)

    result: DiscoveryResult = DiscoveryResult(
        status="completed",
        metadata=DiscoveryMetadata(
            scan_mode=scan_mode,
            discovery_concurrency=discovery_concurrency,
            discovery_deployment_input_limit_tokens=deployment_input_limit_tokens,
            discovery_chunk_target_tokens=chunk_target_tokens,
            discovery_chunk_target_ratio=chunk_target_ratio,
            discovery_chunk_hard_limit_tokens=chunk_hard_limit_tokens,
            discovery_chunk_strategy=chunk_strategy,
            discovery_chunk_count=len(chunks),
        ),
        counts=DiscoveryCounts(
            scannable_file_count=len(entries),
            scanned_file_count=len(file_results),
            skipped_file_count=len(all_skipped_files),
            candidate_count=len(candidates),
        ),
        files=file_results,
        skipped_files=all_skipped_files,
        candidates=candidates,
    )
    return result


def persist_discovery_result(
    *, discovery_artifacts_path: Path, result: DiscoveryResult
) -> None:
    """Persist the canonical discovery stage result."""
    persist_json_artifact(
        discovery_artifacts_path,
        "discovery-result",
        result.model_dump(mode="json", exclude_none=True),
    )


def prepare_discovery_chunks(
    *,
    workspace_root: Path,
    scan_mode: str,
    scan_scope: dict[str, Any],
    discovery_artifacts_path: Path,
    chunk_target_ratio: tuple[int, int] = (1, 5),
    chunk_strategy: str | None = None,
) -> DiscoveryManifest:
    remove_json_artifacts(
        discovery_artifacts_path,
        ("discovery-result", "discovery-chunks"),
    )
    is_incremental = scan_mode == "incremental"
    if is_incremental:
        entries, skipped_files = _build_incremental_scan_manifest(
            workspace_root=workspace_root,
            scan_scope=scan_scope,
            changed_files=_load_incremental_changed_files(scan_scope),
            discovery_artifacts_path=discovery_artifacts_path,
        )
    else:
        entries, skipped_files = _build_scan_manifest(
            workspace_root=workspace_root,
            scan_scope=scan_scope,
            discovery_artifacts_path=discovery_artifacts_path,
        )

    (
        deployment_input_limit_tokens,
        chunk_target_tokens,
        chunk_hard_limit_tokens,
    ) = discovery_chunk_token_limits(chunk_target_ratio)
    resolved_chunk_strategy = chunk_strategy or _resolve_discovery_chunk_strategy()
    if resolved_chunk_strategy not in {"batched", "single-file"}:
        raise ValueError("Discovery chunk strategy must be 'batched' or 'single-file'.")
    chunk_target_ratio_text = f"{chunk_target_ratio[0]}/{chunk_target_ratio[1]}"
    chunks, chunk_skipped_files = _pack_discovery_chunks(
        entries=entries,
        root=workspace_root,
        target_tokens=chunk_target_tokens,
        hard_limit_tokens=chunk_hard_limit_tokens,
        strategy=resolved_chunk_strategy,
    )
    skipped_files.extend(chunk_skipped_files)
    persist_json_artifact(
        discovery_artifacts_path,
        "discovery-chunks",
        {
            "metadata": {
                "deployment_input_limit_tokens": deployment_input_limit_tokens,
                "chunk_target_tokens": chunk_target_tokens,
                "chunk_target_ratio": chunk_target_ratio_text,
                "chunk_hard_limit_tokens": chunk_hard_limit_tokens,
                "chunk_strategy": resolved_chunk_strategy,
            },
            "counts": {
                "chunk_count": len(chunks),
                "file_count": sum(len(chunk.entries) for chunk in chunks),
            },
            "chunks": [chunk.model_dump(exclude_none=True) for chunk in chunks],
        },
    )
    return DiscoveryManifest(
        workspace_root=str(workspace_root),
        discovery_artifacts_path=str(discovery_artifacts_path),
        scan_mode="incremental" if is_incremental else "full",
        entries=entries,
        skipped_files=skipped_files,
        chunks=chunks,
        deployment_input_limit_tokens=deployment_input_limit_tokens,
        chunk_target_tokens=chunk_target_tokens,
        chunk_target_ratio=chunk_target_ratio_text,
        chunk_hard_limit_tokens=chunk_hard_limit_tokens,
        chunk_strategy=resolved_chunk_strategy,
        max_concurrency=_resolve_discovery_max_concurrency(len(chunks)),
    )
