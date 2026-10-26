"""Build, publish, and materialize immutable memory tree artifacts."""

import shutil
import tarfile
import tempfile
from pathlib import Path
from urllib.parse import urlparse

from sec_review_agents.artifacts.materialize import materialize_artifact
from sec_review_agents.artifacts.object_storage import publish_immutable_s3_artifact
from sec_review_agents.artifacts.reference import (
    ARCHIVE_MEDIA_TYPE,
    ArtifactReference,
    local_artifact_reference,
    require_artifact_media_type,
)
from sec_review_agents.artifacts.tar_zstd import validate_restricted_pax_archive
from sec_review_agents.contract_versions import MEMORY_TREE_ARTIFACT_VERSION

MEMORY_TREE_ARTIFACT_FILENAME = f"memory-tree.{MEMORY_TREE_ARTIFACT_VERSION}.tar.zst"
MEMORY_TREE_ARTIFACT_MANIFEST = "manifest.json"
MEMORY_TREE_ARTIFACT_MANIFEST_VERSION = 1
MEMORY_TREE_ARTIFACT_MANIFEST_BYTES = (
    f'{{"version":{MEMORY_TREE_ARTIFACT_MANIFEST_VERSION}}}\n'.encode()
)
MAX_MEMORY_TREE_ARTIFACT_BYTES = 64 * 1024 * 1024
MAX_MEMORY_TREE_ARTIFACT_ENTRIES = 10_000
MAX_MEMORY_TREE_FILE_BYTES = 16 * 1024 * 1024
MAX_EXTRACTED_MEMORY_BYTES = 256 * 1024 * 1024

DEFAULT_MEMORY_INDEX = """# Security Review Experience Memory

Reviewed security-review experience extracted from past transcripts.

Use the top of this file as the runtime index. Keep it short: describe available
experience topics and route future agents to topic files in `topics/`.

Memory is guidance only; it is not evidence for the current repository, patch,
or finding.
"""


def _validate_content_path(relative: str) -> None:
    if relative == "MEMORY.md":
        return
    parts = relative.split("/")
    if (
        not relative.startswith("topics/")
        or not relative.endswith(".md")
        or "\\" in relative
        or any(part in {"", ".", ".."} for part in parts)
    ):
        raise ValueError(f"Invalid memory tree content path: {relative}")


def _read_content_file(path: Path, relative: str) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Memory tree contains unsupported entry: {path}")
    content = path.read_bytes()
    if len(content) > MAX_MEMORY_TREE_FILE_BYTES:
        raise ValueError(f"Memory tree file exceeds the size limit: {relative}")
    try:
        content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError(f"Memory tree file is not valid UTF-8: {relative}") from error
    return content


def _archive_tree_entries(content: dict[str, bytes]) -> dict[str, bytes | None]:
    entries: dict[str, bytes | None] = {"memory/topics/": None}
    for relative, value in content.items():
        current = "memory/"
        for part in relative.split("/")[:-1]:
            current += f"{part}/"
            entries[current] = None
        entries[f"memory/{relative}"] = value
    return entries


def _collect_memory_content(root: Path) -> dict[str, bytes]:
    index = root / "MEMORY.md"
    if not index.is_file() or index.is_symlink():
        raise ValueError(f"Memory tree index is missing: {index}")
    content = {"MEMORY.md": _read_content_file(index, "MEMORY.md")}
    topics = root / "topics"
    if topics.is_symlink() or (topics.exists() and not topics.is_dir()):
        raise ValueError(f"Memory tree contains unsupported entry: {topics}")
    if topics.is_dir():
        for path in sorted(topics.rglob("*")):
            if path.is_dir() and not path.is_symlink():
                continue
            relative = path.relative_to(root).as_posix()
            _validate_content_path(relative)
            content[relative] = _read_content_file(path, relative)
    entries = _archive_tree_entries(content)
    if len(entries) + 2 > MAX_MEMORY_TREE_ARTIFACT_ENTRIES:
        raise ValueError("Memory tree exceeds the entry count limit.")
    if sum(map(len, content.values())) + len(MEMORY_TREE_ARTIFACT_MANIFEST_BYTES) > (
        MAX_EXTRACTED_MEMORY_BYTES
    ):
        raise ValueError("Memory tree exceeds the extracted size limit.")
    return content


def _add_directory(archive: tarfile.TarFile, name: str) -> None:
    info = tarfile.TarInfo(name)
    info.mtime = 0
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.type = tarfile.DIRTYPE
    info.mode = 0o755
    archive.addfile(info)


def _add_file(archive: tarfile.TarFile, name: str, content: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.mtime = 0
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.size = len(content)
    info.mode = 0o644
    with tempfile.SpooledTemporaryFile() as source:
        source.write(content)
        source.seek(0)
        archive.addfile(info, source)


def _write_memory_tree_archive(
    archive: tarfile.TarFile, content: dict[str, bytes]
) -> None:
    _add_file(
        archive,
        MEMORY_TREE_ARTIFACT_MANIFEST,
        MEMORY_TREE_ARTIFACT_MANIFEST_BYTES,
    )
    _add_directory(archive, "memory/")
    entries = _archive_tree_entries(content)
    for name in sorted(entries):
        entry_content = entries[name]
        if entry_content is None:
            _add_directory(archive, name)
        else:
            _add_file(archive, name, entry_content)


def _validate_archive(archive_path: Path) -> None:
    envelope_entries = validate_restricted_pax_archive(archive_path)
    with tarfile.open(archive_path, mode="r:zst") as archive:
        members = archive.getmembers()
        if len(envelope_entries) != len(members):
            raise ValueError("Memory tree tar projection does not match its headers.")
        if len(members) > MAX_MEMORY_TREE_ARTIFACT_ENTRIES:
            raise ValueError("Memory tree exceeds the entry count limit.")
        names: set[str] = set()
        previous_name = ""
        total_size = 0
        for index, member in enumerate(members):
            name = member.name + (
                "/" if member.isdir() and not member.name.endswith("/") else ""
            )
            if name in names:
                raise ValueError(f"Memory tree contains a duplicate entry: {name}")
            names.add(name)
            if set(member.pax_headers) - {"path"}:
                raise ValueError(
                    f"Memory tree contains unsupported PAX metadata: {name}"
                )
            if envelope_entries[index].path != name:
                raise ValueError("Memory tree PAX path projection is inconsistent.")
            if index == 0 and name != MEMORY_TREE_ARTIFACT_MANIFEST:
                raise ValueError("Memory tree manifest must be the first entry.")
            if index > 1 and name <= previous_name:
                raise ValueError("Memory tree entries are not in canonical order.")
            previous_name = name
            if (
                member.mtime != 0
                or member.uid != 0
                or member.gid != 0
                or member.uname != ""
                or member.gname != ""
            ):
                raise ValueError(f"Memory tree entry metadata is invalid: {name}")
            if name in {"memory/", "memory/topics/"} or (
                name.startswith("memory/topics/") and name.endswith("/")
            ):
                if not member.isdir() or member.mode != 0o755:
                    raise ValueError(f"Memory tree directory is invalid: {name}")
                continue
            if name == MEMORY_TREE_ARTIFACT_MANIFEST:
                source = archive.extractfile(member)
                if (
                    not member.isfile()
                    or member.mode != 0o644
                    or source is None
                    or source.read() != MEMORY_TREE_ARTIFACT_MANIFEST_BYTES
                ):
                    raise ValueError("Memory tree manifest is invalid.")
                total_size += member.size
                continue
            if not name.startswith("memory/") or name.endswith("/"):
                raise ValueError(f"Unexpected memory tree entry: {name}")
            relative = name.removeprefix("memory/")
            _validate_content_path(relative)
            if not member.isfile() or member.mode != 0o644:
                raise ValueError(f"Memory tree file is invalid: {name}")
            if member.size > MAX_MEMORY_TREE_FILE_BYTES:
                raise ValueError(f"Memory tree file exceeds the size limit: {name}")
            source = archive.extractfile(member)
            if source is None:
                raise ValueError(f"Memory tree file is unreadable: {name}")
            try:
                source.read().decode("utf-8")
            except UnicodeDecodeError as error:
                raise ValueError(
                    f"Memory tree file is not valid UTF-8: {name}"
                ) from error
            total_size += member.size
            if total_size > MAX_EXTRACTED_MEMORY_BYTES:
                raise ValueError("Memory tree exceeds the extracted size limit.")
        required = {
            MEMORY_TREE_ARTIFACT_MANIFEST,
            "memory/",
            "memory/MEMORY.md",
            "memory/topics/",
        }
        if not required.issubset(names):
            raise ValueError("Memory tree required entries are missing.")


def _extract_validated_archive(archive_path: Path, destination: Path) -> Path:
    _validate_archive(archive_path)
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    with tarfile.open(archive_path, mode="r:zst") as archive:
        archive.extractall(destination, filter="data")
    return destination


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
    content = _collect_memory_content(memory_content_root)
    output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = output_dir / MEMORY_TREE_ARTIFACT_FILENAME
    with tarfile.open(archive_path, mode="w:zst", format=tarfile.PAX_FORMAT) as archive:
        _write_memory_tree_archive(archive, content)
    if archive_path.stat().st_size > MAX_MEMORY_TREE_ARTIFACT_BYTES:
        archive_path.unlink()
        raise ValueError("Memory tree archive exceeds the size limit.")
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
    root = _extract_validated_archive(archive_path, destination)
    memory_root = root / "memory"
    return memory_root


__all__ = [
    "DEFAULT_MEMORY_INDEX",
    "MEMORY_TREE_ARTIFACT_FILENAME",
    "build_memory_tree_artifact",
    "materialize_memory_tree",
    "memory_tree_artifact_s3_key",
    "publish_memory_tree_artifact",
]
