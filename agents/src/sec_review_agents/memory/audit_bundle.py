"""Publish immutable audit transcripts produced by memory agents."""

import io
import json
import tarfile
from pathlib import Path

from sec_review_agents.artifacts.immutable_s3 import publish_immutable_s3_artifact
from sec_review_agents.artifacts.reference import (
    ArtifactReference,
    local_artifact_reference,
)
from sec_review_agents.runtime.transcripts import TRANSCRIPT_SUFFIX
from sec_review_agents.utils.files import slug_filename_component

MEMORY_AUDIT_BUNDLE_FILENAME = "memory-agent-audit.v1.tar.zst"
MEMORY_AUDIT_MANIFEST = "manifest.json"


def _add_bytes(archive: tarfile.TarFile, *, name: str, content: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.mtime = 0
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mode = 0o644
    info.size = len(content)
    archive.addfile(info, io.BytesIO(content))


def memory_audit_s3_key(*, agent_name: str, digest: str) -> str:
    agent = slug_filename_component(agent_name, fallback="memory-agent")
    sha256 = digest.removeprefix("sha256:")
    if len(sha256) != 64 or any(char not in "0123456789abcdef" for char in sha256):
        raise ValueError("Memory audit key requires a lowercase SHA-256 digest.")
    return f"memory/audit/{agent}/{sha256}/{MEMORY_AUDIT_BUNDLE_FILENAME}"


def publish_memory_audit_bundle(
    *,
    agent_name: str,
    transcript_paths: list[Path],
    output_dir: Path,
    remote: bool = True,
) -> ArtifactReference:
    """Archive one memory-agent invocation and publish it immutably."""
    paths = sorted(path.resolve() for path in transcript_paths)
    if not paths or any(not path.is_file() for path in paths):
        raise ValueError("Memory audit bundle requires transcript files.")
    if any(path.suffix != TRANSCRIPT_SUFFIX for path in paths):
        raise ValueError("Memory audit bundle accepts only transcript JSONL files.")

    output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = output_dir / MEMORY_AUDIT_BUNDLE_FILENAME
    transcript_names = [
        f"transcripts/{index:04d}{TRANSCRIPT_SUFFIX}"
        for index in range(1, len(paths) + 1)
    ]
    manifest = {
        "version": 1,
        "agent_name": agent_name,
        "transcripts": transcript_names,
    }
    manifest_bytes = (json.dumps(manifest, separators=(",", ":")) + "\n").encode(
        "utf-8"
    )
    with tarfile.open(archive_path, mode="w:zst") as archive:
        _add_bytes(
            archive,
            name=MEMORY_AUDIT_MANIFEST,
            content=manifest_bytes,
        )
        for relative, source in zip(transcript_names, paths, strict=True):
            _add_bytes(archive, name=relative, content=source.read_bytes())

    reference = local_artifact_reference(archive_path)
    if not remote:
        return reference
    key = memory_audit_s3_key(agent_name=agent_name, digest=reference.digest)
    return publish_immutable_s3_artifact(
        reference,
        key=key,
        description="managed memory audit bundle",
    )


__all__ = ["memory_audit_s3_key", "publish_memory_audit_bundle"]
