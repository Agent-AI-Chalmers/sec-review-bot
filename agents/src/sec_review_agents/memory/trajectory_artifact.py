"""Publish immutable compressed trajectories produced by memory agents."""

import shutil
from compression.zstd import ZstdFile
from pathlib import Path

from sec_review_agents.artifacts.object_storage import publish_immutable_s3_artifact
from sec_review_agents.artifacts.reference import (
    ZSTD_MEDIA_TYPE,
    ArtifactReference,
    local_artifact_reference,
)
from sec_review_agents.runtime.trajectories import TRAJECTORY_SUFFIX
from sec_review_agents.utils.files import slug_filename_component

MEMORY_AGENT_TRAJECTORY_FILENAME = "trajectory.v1.jsonl.zst"
MEMORY_AGENT_TRAJECTORY_COMPRESSION_LEVEL = 10


def memory_agent_trajectory_s3_key(*, agent_name: str, digest: str) -> str:
    agent = slug_filename_component(agent_name, fallback="memory-agent")
    sha256 = digest.removeprefix("sha256:")
    if len(sha256) != 64 or any(char not in "0123456789abcdef" for char in sha256):
        raise ValueError(
            "Memory agent trajectory key requires a lowercase SHA-256 digest."
        )
    return f"memory/trajectories/{agent}/{sha256}/{MEMORY_AGENT_TRAJECTORY_FILENAME}"


def publish_memory_agent_trajectory(
    *,
    agent_name: str,
    trajectory_path: Path,
    output_dir: Path,
    remote: bool = True,
) -> ArtifactReference:
    """Compress and publish one memory-agent invocation trajectory."""
    source = trajectory_path.resolve()
    if not source.is_file():
        raise ValueError("Memory agent trajectory must be a file.")
    if source.suffix != TRAJECTORY_SUFFIX:
        raise ValueError("Memory agent trajectory must be a JSONL file.")

    output_dir.mkdir(parents=True, exist_ok=True)
    compressed_path = output_dir / MEMORY_AGENT_TRAJECTORY_FILENAME
    with (
        source.open("rb") as source_file,
        ZstdFile(
            compressed_path,
            mode="wb",
            level=MEMORY_AGENT_TRAJECTORY_COMPRESSION_LEVEL,
        ) as compressed_file,
    ):
        shutil.copyfileobj(source_file, compressed_file)

    reference = local_artifact_reference(
        compressed_path,
        media_type=ZSTD_MEDIA_TYPE,
    )
    if not remote:
        return reference
    key = memory_agent_trajectory_s3_key(
        agent_name=agent_name,
        digest=reference.digest,
    )
    return publish_immutable_s3_artifact(
        reference,
        key=key,
        description="memory agent trajectory",
    )


__all__ = [
    "memory_agent_trajectory_s3_key",
    "publish_memory_agent_trajectory",
]
