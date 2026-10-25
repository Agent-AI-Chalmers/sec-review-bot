"""Local filesystem store for observations and the memory tree."""

import contextlib
import fcntl
from pathlib import Path
from typing import Literal, overload

from sec_review_agents.memory.local_state import initialize_memory_state
from sec_review_agents.memory.transcripts import (
    MEMORY_AGENT_TRANSCRIPTS_DIRNAME,
)
from sec_review_agents.utils.env import env_value

AGENT_MEMORY_DIR_ENV = "AGENT_MEMORY_DIR"
MEMORY_DIRNAME = "memory"
MEMORY_OBSERVATIONS_DIRNAME = "observations"
MEMORY_INDEX_MAX_LINES = 200
MEMORY_INDEX_MAX_CHARS = 25_000

DEFAULT_MEMORY_INDEX = """# Security Review Experience Memory

Reviewed security-review experience extracted from past transcripts.

Use the top of this file as the runtime index. Keep it short: describe available
experience topics and route future agents to topic files in `topics/`.

Memory is guidance only; it is not evidence for the current repository, patch,
or finding.
"""


def initialize_memory_store(memory_store_dir: Path) -> Path:
    resolved_store_dir = memory_store_dir.expanduser().resolve()
    resolved_store_dir.mkdir(parents=True, exist_ok=True)
    # Only memory/MEMORY.md and memory/topics are exposed to review agents.
    content_dir = memory_content_dir(resolved_store_dir)
    content_dir.mkdir(exist_ok=True)
    (content_dir / "topics").mkdir(exist_ok=True)
    (resolved_store_dir / MEMORY_OBSERVATIONS_DIRNAME).mkdir(exist_ok=True)
    transcript_root = resolved_store_dir / MEMORY_AGENT_TRANSCRIPTS_DIRNAME
    (transcript_root / "memory-extractor").mkdir(parents=True, exist_ok=True)
    (transcript_root / "memory-maintainer").mkdir(exist_ok=True)
    initialize_memory_state(resolved_store_dir)
    index_path = content_dir / "MEMORY.md"
    if not index_path.exists():
        index_path.write_text(DEFAULT_MEMORY_INDEX, encoding="utf-8")
    return resolved_store_dir


def memory_content_dir(memory_store_dir: Path) -> Path:
    return memory_store_dir / MEMORY_DIRNAME


def memory_observations_dir(memory_store_dir: Path) -> Path:
    return memory_store_dir / MEMORY_OBSERVATIONS_DIRNAME


@contextlib.contextmanager
def memory_store_lock(
    memory_store_dir: Path,
    *,
    exclusive: bool,
    blocking: bool = True,
):
    lock_path = memory_store_dir / ".lock"
    with lock_path.open("a+", encoding="utf-8") as lock_file:
        lock_flags = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
        if not blocking:
            lock_flags |= fcntl.LOCK_NB
        acquired = False
        try:
            fcntl.flock(lock_file.fileno(), lock_flags)
            acquired = True
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            if acquired:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


@overload
def resolve_memory_store_dir(
    configured_path: Path | None, *, required: Literal[True]
) -> Path: ...


@overload
def resolve_memory_store_dir(
    configured_path: Path | None, *, required: Literal[False]
) -> Path | None: ...


def resolve_memory_store_dir(
    configured_path: Path | None, *, required: bool
) -> Path | None:
    if configured_path is not None:
        return configured_path.expanduser().resolve()
    configured = env_value(AGENT_MEMORY_DIR_ENV)
    if configured:
        return Path(configured).expanduser().resolve()
    if required:
        raise ValueError(
            "Memory store is required. "
            f"Pass --memory-store-dir or set {AGENT_MEMORY_DIR_ENV}."
        )
    return None


def initialize_configured_memory_store() -> Path | None:
    from sec_review_agents.memory.catalog_client import (
        configured_memory_catalog_client,
    )

    if configured_memory_catalog_client() is not None:
        return None
    memory_store_dir = resolve_memory_store_dir(None, required=False)
    if memory_store_dir is None:
        return None
    return initialize_memory_store(memory_store_dir)
