import os
from compression.zstd import decompress
from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.artifacts.reference import ZSTD_MEDIA_TYPE
from sec_review_agents.memory.trajectory_artifact import (
    memory_agent_trajectory_s3_key,
    publish_memory_agent_trajectory,
)


def test_memory_agent_trajectory_is_content_deterministic(tmp_path: Path) -> None:
    first = tmp_path / "first.jsonl"
    second = tmp_path / "second.jsonl"
    content = b'{"seq":1,"event":"message"}\n'
    first.write_bytes(content)
    second.write_bytes(content)
    os.utime(first, (1, 1))
    os.utime(second, (2, 2))

    first_reference = publish_memory_agent_trajectory(
        agent_name="memory-extractor",
        trajectory_path=first,
        output_dir=tmp_path / "first-output",
        remote=False,
    )
    second_reference = publish_memory_agent_trajectory(
        agent_name="memory-extractor",
        trajectory_path=second,
        output_dir=tmp_path / "second-output",
        remote=False,
    )

    assert first_reference.digest == second_reference.digest
    assert first_reference.size_bytes == second_reference.size_bytes
    assert first_reference.media_type == ZSTD_MEDIA_TYPE
    compressed_path = Path(first_reference.uri.removeprefix("file://"))
    assert compressed_path.name == "trajectory.v1.jsonl.zst"
    assert decompress(compressed_path.read_bytes()) == content


def test_memory_agent_trajectory_requires_one_jsonl_file(tmp_path: Path) -> None:
    trajectory = tmp_path / "trajectory.txt"
    trajectory.write_text("{}\n", encoding="utf-8")

    with pytest.raises(ValueError, match="must be a JSONL file"):
        publish_memory_agent_trajectory(
            agent_name="memory-maintainer",
            trajectory_path=trajectory,
            output_dir=tmp_path / "output",
            remote=False,
        )


def test_memory_agent_trajectory_requires_s3_configuration(tmp_path: Path) -> None:
    trajectory = tmp_path / "trajectory.jsonl"
    trajectory.write_text("{}\n", encoding="utf-8")

    with (
        patch.dict("os.environ", {}, clear=True),
        pytest.raises(RuntimeError, match="SEC_REVIEW_ARTIFACT_S3_BUCKET"),
    ):
        publish_memory_agent_trajectory(
            agent_name="memory-extractor",
            trajectory_path=trajectory,
            output_dir=tmp_path / "output",
        )


def test_memory_agent_trajectory_uses_trajectory_namespace() -> None:
    digest = f"sha256:{'a' * 64}"

    assert memory_agent_trajectory_s3_key(
        agent_name="memory-extractor",
        digest=digest,
    ) == ("memory/trajectories/memory-extractor/" f"{'a' * 64}/trajectory.v1.jsonl.zst")
