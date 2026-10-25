"""Build, publish, and materialize immutable memory tree artifacts."""

import json
import shutil
import tarfile
import tempfile
from pathlib import Path
from urllib.parse import urlparse

from sec_review_agents.artifacts.archive import extract_archive
from sec_review_agents.artifacts.materialize import materialize_artifact
from sec_review_agents.artifacts.object_storage import publish_immutable_s3_artifact
from sec_review_agents.artifacts.reference import (
    ARCHIVE_MEDIA_TYPE,
    ArtifactReference,
    local_artifact_reference,
    require_artifact_media_type,
)

MEMORY_TREE_ARTIFACT_FILENAME = "memory-tree.v1.tar.zst"
MEMORY_TREE_ARTIFACT_MANIFEST = "manifest.json"
MAX_MEMORY_TREE_ARTIFACT_BYTES = 64 * 1024 * 1024
MAX_MEMORY_TREE_ARTIFACT_ENTRIES = 10_000
MAX_EXTRACTED_MEMORY_BYTES = 256 * 1024 * 1024


def _add_regular_tree(archive: tarfile.TarFile, root: Path) -> None:
    for path in [root, *sorted(root.rglob("*"))]:
        if path.is_symlink() or (not path.is_dir() and not path.is_file()):
            raise ValueError(f"Memory tree contains unsupported entry: {path}")
        relative = path.relative_to(root.parent).as_posix()
        info = tarfile.TarInfo(relative + ("/" if path.is_dir() else ""))
        info.mtime = 0
        info.uid = 0
        info.gid = 0
        info.uname = ""
        info.gname = ""
        if path.is_dir():
            info.type = tarfile.DIRTYPE
            info.mode = 0o755
            archive.addfile(info)
            continue
        info.size = path.stat().st_size
        info.mode = 0o644
        with path.open("rb") as source:
            archive.addfile(info, source)


def memory_tree_artifact_s3_key(digest: str) -> str:
    sha256 = digest.removeprefix("sha256:")
    if len(sha256) != 64 or any(char not in "0123456789abcdef" for char in sha256):
        raise ValueError(
            "Memory tree artifact key requires a lowercase SHA-256 digest."
        )
    return f"memory/trees/{sha256}/{MEMORY_TREE_ARTIFACT_FILENAME}"


def build_memory_tree_artifact(
    *, memory_content_root: Path, output_dir: Path
) -> ArtifactReference:
    """Build a deterministic archive from a memory tree."""
    index = memory_content_root / "MEMORY.md"
    if not index.is_file():
        raise ValueError(f"Memory tree index is missing: {index}")
    output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = output_dir / MEMORY_TREE_ARTIFACT_FILENAME
    with tempfile.TemporaryDirectory(prefix="sec-review-memory-tree-") as tempdir:
        artifact_root = Path(tempdir) / "artifact"
        memory_root = artifact_root / "memory"
        memory_root.mkdir(parents=True)
        shutil.copy2(index, memory_root / "MEMORY.md")
        topics = memory_content_root / "topics"
        if topics.is_dir():
            shutil.copytree(topics, memory_root / "topics")
        else:
            (memory_root / "topics").mkdir()
        (artifact_root / MEMORY_TREE_ARTIFACT_MANIFEST).write_text(
            json.dumps({"version": 1}, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        with tarfile.open(archive_path, mode="w:zst") as archive:
            manifest_path = artifact_root / MEMORY_TREE_ARTIFACT_MANIFEST
            manifest_info = tarfile.TarInfo(MEMORY_TREE_ARTIFACT_MANIFEST)
            manifest_info.mtime = 0
            manifest_info.uid = 0
            manifest_info.gid = 0
            manifest_info.mode = 0o644
            manifest_info.size = manifest_path.stat().st_size
            with manifest_path.open("rb") as source:
                archive.addfile(manifest_info, source)
            _add_regular_tree(archive, memory_root)
    return local_artifact_reference(archive_path)


def publish_memory_tree_artifact(
    *,
    memory_content_root: Path,
    output_dir: Path,
    remote: bool = True,
) -> ArtifactReference:
    reference = build_memory_tree_artifact(
        memory_content_root=memory_content_root,
        output_dir=output_dir,
    )
    if not remote:
        return reference
    key = memory_tree_artifact_s3_key(reference.digest)
    return publish_immutable_s3_artifact(
        reference,
        key=key,
        description="memory tree artifact",
    )


def materialize_memory_tree(
    reference: ArtifactReference,
    *,
    destination: Path,
) -> Path:
    require_artifact_media_type(reference, ARCHIVE_MEDIA_TYPE)
    archive_path = materialize_artifact(
        reference,
        destination.with_suffix(".tar.zst"),
        maximum_size=MAX_MEMORY_TREE_ARTIFACT_BYTES,
        expected_s3_key=(
            memory_tree_artifact_s3_key(reference.digest)
            if urlparse(reference.uri).scheme == "s3"
            else None
        ),
    )
    root = extract_archive(
        archive_path,
        destination,
        maximum_entries=MAX_MEMORY_TREE_ARTIFACT_ENTRIES,
        maximum_extracted_bytes=MAX_EXTRACTED_MEMORY_BYTES,
    )
    manifest = json.loads(
        (root / MEMORY_TREE_ARTIFACT_MANIFEST).read_text(encoding="utf-8")
    )
    memory_root = root / "memory"
    if manifest != {"version": 1} or not (memory_root / "MEMORY.md").is_file():
        raise ValueError("Memory tree artifact manifest or content is invalid.")
    return memory_root


__all__ = [
    "MEMORY_TREE_ARTIFACT_FILENAME",
    "build_memory_tree_artifact",
    "materialize_memory_tree",
    "memory_tree_artifact_s3_key",
    "publish_memory_tree_artifact",
]
