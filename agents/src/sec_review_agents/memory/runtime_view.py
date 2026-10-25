"""Materialize the read-only memory tree view consumed by review agents."""

import fcntl
import hashlib
import shutil
import tempfile
from pathlib import Path
from urllib.parse import urlparse

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.filesystem.path_views import PathView, memory_view
from sec_review_agents.memory.local_store import (
    MEMORY_DIRNAME,
    memory_content_dir,
    memory_store_lock,
    resolve_memory_store_dir,
)
from sec_review_agents.utils.env import env_value

AGENT_MEMORY_MATERIALIZED_ROOT_ENV = "AGENT_MEMORY_MATERIALIZED_ROOT"

_DEFAULT_MEMORY_MATERIALIZED_ROOT: Path | None = None


def memory_runtime_available() -> bool:
    """Return whether a configured memory view is ready for agent startup."""
    return materialize_configured_memory_view() is not None


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
    from sec_review_agents.memory.catalog_client import (
        configured_memory_catalog_client,
    )
    from sec_review_agents.memory.memory_tree_artifact import materialize_memory_tree

    catalog_client = configured_memory_catalog_client()
    if catalog_client is not None:
        active = catalog_client.active_version()
        raw_reference = active.get("artifact_reference")
        if raw_reference is None:
            return None
        reference = ArtifactReference.from_mapping(raw_reference)
        if urlparse(reference.uri).scheme != "s3":
            raise ValueError("Catalog active memory must use an S3 artifact reference.")
        base_root = memory_materialized_base_root()
        base_root.mkdir(parents=True, exist_ok=True)
        digest = reference.digest.removeprefix("sha256:")
        artifact_root = base_root / f"memory-tree-{digest}"
        content_root = artifact_root / MEMORY_DIRNAME
        lock_path = base_root / f".{artifact_root.name}.lock"
        with lock_path.open("w", encoding="utf-8") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            if not (content_root / "MEMORY.md").is_file():
                if artifact_root.exists():
                    shutil.rmtree(artifact_root)
                try:
                    materialized = materialize_memory_tree(
                        reference,
                        destination=artifact_root,
                    )
                except Exception:
                    if artifact_root.exists():
                        shutil.rmtree(artifact_root)
                    raise
                if materialized != content_root:
                    raise RuntimeError(
                        "Memory tree materialized at an unexpected path."
                    )
        return content_root

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


def configured_memory_path_view() -> PathView | None:
    memory_root = materialize_configured_memory_view()
    return None if memory_root is None else memory_view(host_path=memory_root)
