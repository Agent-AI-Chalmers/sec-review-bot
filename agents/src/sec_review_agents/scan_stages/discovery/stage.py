import fnmatch
import hashlib
import os
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from langchain_core.messages.utils import count_tokens_approximately

from sec_review_agents.agents.discovery.prompts import (
    build_repository_discovery_system_prompt,
    build_repository_discovery_user_prompt,
)
from sec_review_agents.observability.diagnostics import (
    log_stage_completed,
)
from sec_review_agents.runtime.deployment_limits import (
    resolve_bound_deployment_max_input_tokens,
)
from sec_review_agents.scan_stages.discovery.execution import (
    run_repository_discovery_agent,
)
from sec_review_agents.scan_stages.discovery.result import (
    DiscoveryFileResult,
    DiscoveryResult,
)
from sec_review_agents.utils.env import parse_int_env
from sec_review_agents.utils.files import persist_json, reset_stage_attempt_artifacts

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
GROUNDED_STATUS = "grounded"
NEEDS_GROUNDING_STATUS = "needs-grounding"


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


def _normalize_paths_ignore(raw_patterns: Any) -> list[str]:
    if not isinstance(raw_patterns, list):
        raise ValueError(
            "Repository discovery requires scan_scope.paths_ignore to be a list."
        )
    normalized: list[str] = []
    for index, item in enumerate(raw_patterns):
        if not isinstance(item, str):
            raise ValueError(
                "Repository discovery requires scan_scope.paths_ignore"
                f"[{index}] to be a string."
            )
        pattern = item.strip().replace("\\", "/")
        if not pattern:
            raise ValueError(
                "Repository discovery requires scan_scope.paths_ignore"
                f"[{index}] to be non-empty."
            )
        normalized.append(pattern)
    return normalized


def _matches_paths_ignore(relative_path: Path, patterns: list[str]) -> bool:
    normalized_path = relative_path.as_posix()
    for pattern in patterns:
        normalized_pattern = pattern.replace("\\", "/")
        if (
            "*" not in normalized_pattern
            and "?" not in normalized_pattern
            and (
                normalized_path == normalized_pattern
                or normalized_path.startswith(f"{normalized_pattern}/")
            )
        ):
            return True
        if fnmatch.fnmatch(normalized_path, normalized_pattern):
            return True
        if not normalized_pattern.startswith("**/") and fnmatch.fnmatch(
            normalized_path, f"**/{normalized_pattern}"
        ):
            return True
    return False


def _resolve_discovery_max_file_bytes() -> tuple[int, str]:
    env_max_file_bytes = parse_int_env(
        os.environ.get("AGENT_DISCOVERY_MAX_FILE_BYTES"), None
    )

    if env_max_file_bytes is not None:
        return max(0, env_max_file_bytes), "AGENT_DISCOVERY_MAX_FILE_BYTES"
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
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    max_file_bytes, max_file_bytes_source = _resolve_discovery_max_file_bytes()
    paths_ignore = _normalize_paths_ignore(scan_scope.get("paths_ignore"))
    entries: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

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

            if _matches_paths_ignore(relative_path, paths_ignore):
                skipped.append(
                    {
                        "path": relative_path_text,
                        "reason": "paths-ignore",
                        "size_bytes": size_bytes,
                    }
                )
                continue
            if not include_file:
                skipped.append(
                    {
                        "path": relative_path_text,
                        "reason": include_reason,
                        "size_bytes": size_bytes,
                    }
                )
                continue
            if max_file_bytes > 0 and size_bytes > max_file_bytes:
                skipped.append(
                    {
                        "path": relative_path_text,
                        "reason": "oversized",
                        "size_bytes": size_bytes,
                    }
                )
                continue
            if read_utf8_text_file(absolute_path) is None:
                skipped.append(
                    {
                        "path": relative_path_text,
                        "reason": "binary-or-unreadable",
                        "size_bytes": size_bytes,
                    }
                )
                continue

            entries.append(
                {
                    "path": relative_path_text,
                    "size_bytes": size_bytes,
                    "language": language,
                    "include_reason": include_reason,
                }
            )

    entries.sort(key=lambda item: item["path"])
    skipped.sort(key=lambda item: item["path"])

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
        "files": entries,
        "skipped_files": skipped,
    }
    persist_json(
        discovery_artifacts_path,
        "scan-manifest.json",
        manifest,
    )
    return entries, skipped


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
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    normalized_path = path_value.as_posix()
    include_file, include_reason, language = _classify_candidate_file(path_value)
    absolute_path = root / path_value
    exists_now = absolute_path.exists()
    size_bytes = absolute_path.stat().st_size if exists_now else 0

    if _matches_paths_ignore(path_value, paths_ignore):
        return None, {
            "path": normalized_path,
            "reason": "paths-ignore",
            "size_bytes": size_bytes,
        }
    if not include_file:
        return None, {
            "path": normalized_path,
            "reason": include_reason,
            "size_bytes": size_bytes,
        }
    if not exists_now:
        return None, {
            "path": normalized_path,
            "reason": "missing-from-workspace",
            "size_bytes": 0,
        }
    if max_file_bytes > 0 and size_bytes > max_file_bytes:
        return None, {
            "path": normalized_path,
            "reason": "oversized",
            "size_bytes": size_bytes,
        }
    if read_utf8_text_file(absolute_path) is None:
        return None, {
            "path": normalized_path,
            "reason": "binary-or-unreadable",
            "size_bytes": size_bytes,
        }

    return {
        "path": normalized_path,
        "size_bytes": size_bytes,
        "language": language,
        "include_reason": include_reason,
    }, None


def _build_incremental_scan_manifest(
    *,
    workspace_root: Path,
    scan_scope: dict[str, Any],
    changed_files: Sequence[Mapping[str, Any]],
    discovery_artifacts_path: Path,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    max_file_bytes, max_file_bytes_source = _resolve_discovery_max_file_bytes()
    paths_ignore = _normalize_paths_ignore(scan_scope.get("paths_ignore"))

    entries: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
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
        if not status:
            raise ValueError(
                "Repository incremental discovery received an empty changed-file status."
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

    entries.sort(key=lambda item: item["path"])
    skipped.sort(key=lambda item: item["path"])

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
        "files": entries,
        "skipped_files": skipped,
    }
    persist_json(
        discovery_artifacts_path,
        "scan-manifest.json",
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
    entries_by_path: dict[str, dict[str, Any]],
    content_by_path: dict[str, str],
    candidate: dict[str, Any],
) -> dict[str, Any] | None:
    category = str(candidate.get("category") or "").strip()
    description = str(candidate.get("description") or "").strip()

    if not category or not description:
        return None

    raw_locations = candidate.get("locations")
    normalized_locations: list[dict[str, Any]] = []
    if isinstance(raw_locations, list):
        for item in raw_locations:
            if not isinstance(item, dict):
                continue
            raw_file = str(item.get("file") or "").strip().lstrip("/")
            if not raw_file and len(entries_by_path) == 1:
                raw_file = next(iter(entries_by_path))
            if raw_file not in content_by_path:
                continue
            label = str(item.get("label") or "").strip()
            if not label:
                continue
            line_count = len(content_by_path[raw_file].splitlines()) or 1
            location: dict[str, Any] = {
                "file": raw_file,
                "label": label,
            }
            raw_line = item.get("line")
            if raw_line is not None:
                if not isinstance(raw_line, str | int):
                    continue
                try:
                    line_value = max(1, int(raw_line))
                except TypeError, ValueError, OverflowError:
                    continue
                if line_value > line_count:
                    continue
                location["line"] = line_value
            normalized_locations.append(location)

    evidence_items = [
        str(item).strip()
        for item in (candidate.get("evidence") or [])
        if str(item).strip()
    ]
    grounded_evidence_items, evidence_files = _grounded_evidence_by_file(
        content_by_path, evidence_items
    )
    if not normalized_locations and grounded_evidence_items:
        evidence_file = evidence_files[grounded_evidence_items[0]]
        grounded_line = _line_number_for_snippet(
            content_by_path[evidence_file], grounded_evidence_items[0], fallback=None
        )
        if grounded_line is not None:
            normalized_locations.append(
                {
                    "file": evidence_file,
                    "line": grounded_line,
                    "label": _evidence_location_label(grounded_evidence_items[0]),
                }
            )

    # Structural constraint: drop candidates that have no verifiable anchor signal at all.
    # We require at least one valid location or one verbatim evidence snippet grounded in file content.
    if not normalized_locations and not grounded_evidence_items:
        return None

    # Grounding validator: classify as grounded only when both signals are present.
    # This makes grounding stricter and keeps one-signal candidates visible but explicitly weaker.
    grounding_status = (
        GROUNDED_STATUS
        if normalized_locations and grounded_evidence_items
        else NEEDS_GROUNDING_STATUS
    )

    primary_line = 0
    if normalized_locations:
        raw_primary_line = normalized_locations[0].get("line")
        if isinstance(raw_primary_line, int):
            primary_line = raw_primary_line
    primary_file = (
        str(normalized_locations[0].get("file"))
        if normalized_locations
        else next(iter(entries_by_path))
    )
    return {
        "candidate_id": _candidate_id(
            primary_file, category, primary_line, description
        ),
        "category": category,
        "locations": normalized_locations,
        "evidence": grounded_evidence_items,
        "description": description,
        "grounding_status": grounding_status,
    }


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
    *, chunk_id: str, entries: Sequence[Mapping[str, Any]], sources: dict[str, str]
) -> int:
    user_prompt = build_repository_discovery_user_prompt(
        chunk={"chunk_id": chunk_id, "entries": [dict(item) for item in entries]},
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
    entries: Sequence[Mapping[str, Any]],
    root: Path,
    target_tokens: int,
    hard_limit_tokens: int,
    strategy: str = DEFAULT_DISCOVERY_CHUNK_STRATEGY,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    chunks: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    current_entries: list[dict[str, Any]] = []
    current_sources: dict[str, str] = {}
    current_tokens = 0

    def emit_current() -> None:
        nonlocal current_entries, current_sources, current_tokens
        if not current_entries:
            return
        chunks.append(
            {
                "chunk_id": f"discovery-chunk-{len(chunks) + 1:04d}",
                "entries": list(current_entries),
                "token_count": current_tokens,
            }
        )
        current_entries = []
        current_sources = {}
        current_tokens = 0

    for entry in entries:
        path = str(entry["path"])
        content = read_utf8_text_file(root / path)
        if content is None:
            skipped.append(
                {
                    "path": path,
                    "reason": "binary-or-unreadable",
                    "size_bytes": entry["size_bytes"],
                }
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
                    {
                        "path": path,
                        "reason": "token-budget-exceeded",
                        "size_bytes": entry["size_bytes"],
                        "token_count": candidate_tokens,
                        "hard_limit_tokens": hard_limit_tokens,
                    }
                )
                continue
            chunks.append(
                {
                    "chunk_id": f"discovery-chunk-{len(chunks) + 1:04d}",
                    "entries": [dict(entry)],
                    "token_count": candidate_tokens,
                }
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
                {
                    "path": path,
                    "reason": "token-budget-exceeded",
                    "size_bytes": entry["size_bytes"],
                    "token_count": candidate_tokens,
                    "hard_limit_tokens": hard_limit_tokens,
                }
            )
            continue
        current_entries = [dict(item) for item in candidate_entries]
        current_sources = candidate_sources
        current_tokens = candidate_tokens
        if current_tokens >= target_tokens:
            emit_current()

    emit_current()
    return chunks, skipped


async def execute_discovery(
    *,
    chunk: Mapping[str, Any],
    sources: Mapping[str, str],
    discovery_artifacts_path: Path | None = None,
) -> dict[str, Any]:
    discovery_result = await run_repository_discovery_agent(
        chunk=chunk,
        sources=sources,
        discovery_artifacts_path=discovery_artifacts_path,
    )
    return {
        "candidates": discovery_result.get("candidates") or [],
    }


def _resolve_discovery_max_concurrency(entry_count: int) -> int:
    configured = (
        parse_int_env(
            os.environ.get("AGENT_DISCOVERY_MAX_CONCURRENCY"),
            DEFAULT_DISCOVERY_MAX_CONCURRENCY,
        )
        or DEFAULT_DISCOVERY_MAX_CONCURRENCY
    )
    bounded = max(1, configured)
    if entry_count <= 0:
        return 1
    return min(bounded, entry_count)


async def scan_discovery_chunk(
    *,
    chunk: Mapping[str, Any],
    root: Path,
    discovery_artifacts_path: Path | None = None,
) -> dict[str, Any]:
    entries = [item for item in chunk.get("entries") or [] if isinstance(item, dict)]
    entries_by_path = {str(entry["path"]): entry for entry in entries}
    sources: dict[str, str] = {}
    skipped_files: list[dict[str, Any]] = []

    for entry in entries:
        path = str(entry["path"])
        content = read_utf8_text_file(root / path)
        if content is None:
            skipped_files.append(
                {
                    "path": path,
                    "reason": "binary-or-unreadable",
                    "size_bytes": entry["size_bytes"],
                }
            )
            continue
        sources[path] = content

    if not sources:
        return {
            "chunk_id": chunk["chunk_id"],
            "file_candidates": [],
            "file_results": [],
            "skipped_files": skipped_files,
        }

    discovery_run = await execute_discovery(
        chunk=chunk,
        sources=sources,
        discovery_artifacts_path=discovery_artifacts_path,
    )
    candidates_by_file: dict[str, list[dict[str, Any]]] = {path: [] for path in sources}
    all_candidates: list[dict[str, Any]] = []
    for item in discovery_run.get("candidates") or []:
        if not isinstance(item, dict):
            continue
        candidate = _normalize_candidate(entries_by_path, sources, item)
        if not candidate:
            continue
        all_candidates.append(candidate)
        candidate_files = {
            str(location.get("file"))
            for location in candidate.get("locations") or []
            if isinstance(location, dict) and str(location.get("file")) in sources
        }
        for path in candidate_files or {next(iter(sources))}:
            candidates_by_file.setdefault(path, []).append(candidate)

    file_results: list[DiscoveryFileResult] = []
    for entry in entries:
        path = str(entry["path"])
        if path not in sources:
            continue
        file_results.append(
            {
                "path": path,
                "language": entry["language"],
                "size_bytes": entry["size_bytes"],
                "candidate_count": len(candidates_by_file.get(path, [])),
            }
        )

    return {
        "chunk_id": chunk["chunk_id"],
        "file_candidates": all_candidates,
        "file_results": file_results,
        "skipped_files": skipped_files,
    }


def build_discovery_result_from_chunks(
    *,
    entries: Sequence[Mapping[str, Any]],
    skipped_files: Sequence[Mapping[str, Any]],
    chunks: Sequence[Mapping[str, Any]],
    chunk_results: Sequence[Mapping[str, Any]],
    scan_mode: str,
    deployment_input_limit_tokens: int,
    chunk_target_tokens: int,
    chunk_target_ratio: str,
    chunk_hard_limit_tokens: int,
    chunk_strategy: str = DEFAULT_DISCOVERY_CHUNK_STRATEGY,
    discovery_artifacts_path: Path,
    started_at: float | None = None,
) -> DiscoveryResult:
    candidates: list[dict[str, Any]] = []
    file_results: list[DiscoveryFileResult] = []
    all_skipped_files = [dict(item) for item in skipped_files]

    for scan_result in chunk_results:
        all_skipped_files.extend(
            dict(item) for item in (scan_result.get("skipped_files") or [])
        )
        chunk_file_results = scan_result.get("file_results") or []

        candidates.extend(scan_result.get("file_candidates") or [])
        file_results.extend(chunk_file_results)

    discovery_concurrency = _resolve_discovery_max_concurrency(len(chunks))
    result: DiscoveryResult = {
        "status": "completed",
        "metadata": {
            "scan_mode": scan_mode,
            "discovery_concurrency": discovery_concurrency,
            "discovery_deployment_input_limit_tokens": deployment_input_limit_tokens,
            "discovery_chunk_target_tokens": chunk_target_tokens,
            "discovery_chunk_target_ratio": chunk_target_ratio,
            "discovery_chunk_hard_limit_tokens": chunk_hard_limit_tokens,
            "discovery_chunk_strategy": chunk_strategy,
            "discovery_chunk_count": len(chunks),
        },
        "counts": {
            "scannable_file_count": len(entries),
            "scanned_file_count": len(file_results),
            "skipped_file_count": len(all_skipped_files),
            "candidate_count": len(candidates),
        },
        "files": file_results,
        "skipped_files": all_skipped_files,
        "candidates": candidates,
    }
    persist_json(
        discovery_artifacts_path,
        "discovery-result.json",
        result,
    )
    if started_at is not None:
        log_stage_completed(
            stage="discovery",
            started_at=started_at,
            scannable_file_count=len(entries),
            skipped_file_count=len(all_skipped_files),
            candidate_count=len(candidates),
            discovery_concurrency=discovery_concurrency,
        )
    return result


def prepare_discovery_chunks(
    *,
    workspace_root: Path,
    scan_mode: str,
    scan_scope: dict[str, Any],
    discovery_artifacts_path: Path,
    chunk_target_ratio: tuple[int, int] = (1, 5),
    chunk_strategy: str | None = None,
) -> dict[str, Any]:
    reset_stage_attempt_artifacts(
        discovery_artifacts_path,
        filenames=(
            "discovery-result.json",
            "discovery-chunks.json",
        ),
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
    persist_json(
        discovery_artifacts_path,
        "discovery-chunks.json",
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
                "file_count": sum(len(chunk.get("entries") or []) for chunk in chunks),
            },
            "chunks": chunks,
        },
    )
    return {
        "workspace_root": str(workspace_root),
        "discovery_artifacts_path": str(discovery_artifacts_path),
        "scan_mode": "incremental" if is_incremental else "full",
        "entries": entries,
        "skipped_files": skipped_files,
        "chunks": chunks,
        "deployment_input_limit_tokens": deployment_input_limit_tokens,
        "chunk_target_tokens": chunk_target_tokens,
        "chunk_target_ratio": chunk_target_ratio_text,
        "chunk_hard_limit_tokens": chunk_hard_limit_tokens,
        "chunk_strategy": resolved_chunk_strategy,
        "max_concurrency": _resolve_discovery_max_concurrency(len(chunks)),
    }
