import contextlib
import fcntl
import hashlib
import shutil
import tempfile
from pathlib import Path
from typing import Literal, overload

from sec_review_agents.features import (
    AGENT_MEMORY_ENABLED_ENV,
    agent_memory_enabled,
)
from sec_review_agents.filesystem.material_views import MaterialView, memory_view
from sec_review_agents.memory.state import initialize_memory_state
from sec_review_agents.utils.env import env_value

AGENT_MEMORY_DIR_ENV = "AGENT_MEMORY_DIR"
AGENT_MEMORY_MATERIALIZED_ROOT_ENV = "AGENT_MEMORY_MATERIALIZED_ROOT"
MEMORY_DIRNAME = "memory"
MEMORY_OBSERVATIONS_DIRNAME = "observations"

_DEFAULT_MEMORY_MATERIALIZED_ROOT: Path | None = None

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
    # AGENT_MEMORY_DIR is a higher-level store. Only memory/MEMORY.md and
    # memory/topics are mounted as memory; observations are source
    # material for maintenance and live beside memory.
    content_dir = memory_content_dir(resolved_store_dir)
    content_dir.mkdir(exist_ok=True)
    (content_dir / "topics").mkdir(exist_ok=True)
    (resolved_store_dir / MEMORY_OBSERVATIONS_DIRNAME).mkdir(exist_ok=True)
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
    if not agent_memory_enabled():
        if required:
            raise ValueError(
                f"Memory is disabled. Set {AGENT_MEMORY_ENABLED_ENV}=true to enable it."
            )
        return None
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
    memory_store_dir = resolve_memory_store_dir(None, required=False)
    if memory_store_dir is None:
        return None
    return initialize_memory_store(memory_store_dir)


def memory_runtime_available() -> bool:
    """Return whether a configured memory store is ready for agent startup."""
    # This answers runtime readiness, not feature policy: memory may be globally
    # enabled, but main agents can only use it when a configured directory
    # already provides a readable MEMORY.md startup index.
    memory_store_dir = resolve_memory_store_dir(None, required=False)
    return (
        memory_store_dir is not None
        and (memory_content_dir(memory_store_dir) / "MEMORY.md").is_file()
    )


def memory_materialized_base_root() -> Path:
    configured = env_value(AGENT_MEMORY_MATERIALIZED_ROOT_ENV)
    if configured:
        return Path(configured).expanduser().resolve()

    global _DEFAULT_MEMORY_MATERIALIZED_ROOT
    if _DEFAULT_MEMORY_MATERIALIZED_ROOT is None:
        _DEFAULT_MEMORY_MATERIALIZED_ROOT = Path(
            tempfile.mkdtemp(prefix="sec-review-agents-memory-")
        ).resolve()
    return _DEFAULT_MEMORY_MATERIALIZED_ROOT


def _memory_source_files(memory_store_dir: Path) -> list[Path]:
    files: list[Path] = []
    content_dir = memory_content_dir(memory_store_dir)
    index_path = content_dir / "MEMORY.md"
    if index_path.is_file():
        files.append(index_path)
    topics_path = content_dir / "topics"
    if topics_path.is_dir():
        files.extend(
            path
            for path in sorted(topics_path.rglob("*"))
            if path.is_file() and not path.name.startswith(".")
        )
    return files


def _memory_view_manifest(memory_store_dir: Path) -> str:
    hasher = hashlib.sha256()
    content_dir = memory_content_dir(memory_store_dir)
    for path in _memory_source_files(memory_store_dir):
        relative_path = path.relative_to(content_dir).as_posix()
        hasher.update(f"file:{relative_path}\n".encode())
        hasher.update(path.read_bytes())
    return hasher.hexdigest()


def _copy_memory_source(memory_store_dir: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    content_dir = memory_content_dir(memory_store_dir)
    for path in _memory_source_files(memory_store_dir):
        relative_path = path.relative_to(content_dir)
        target = destination / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
    (destination / "topics").mkdir(exist_ok=True)


def _rebuild_memory_view(memory_store_dir: Path, destination: Path) -> None:
    temp_destination = Path(
        tempfile.mkdtemp(prefix=f".{destination.name}.", dir=destination.parent)
    )
    try:
        _copy_memory_source(memory_store_dir, temp_destination)
        if destination.exists():
            shutil.rmtree(destination)
        temp_destination.rename(destination)
    finally:
        if temp_destination.exists():
            shutil.rmtree(temp_destination)


def materialize_configured_memory_view() -> Path | None:
    memory_store_dir = resolve_memory_store_dir(None, required=False)
    if (
        memory_store_dir is None
        or not (memory_content_dir(memory_store_dir) / "MEMORY.md").is_file()
    ):
        return None

    base_root = memory_materialized_base_root()
    base_root.mkdir(parents=True, exist_ok=True)
    with memory_store_lock(memory_store_dir, exclusive=False):
        manifest = _memory_view_manifest(memory_store_dir)
        destination = base_root / f"memory-{manifest[:16]}"
        lock_path = base_root / f".{destination.name}.lock"

        with lock_path.open("w", encoding="utf-8") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            if not destination.is_dir():
                _rebuild_memory_view(memory_store_dir, destination)

    return destination


def configured_memory_material_view() -> MaterialView | None:
    memory_root = materialize_configured_memory_view()
    return None if memory_root is None else memory_view(host_path=memory_root)
