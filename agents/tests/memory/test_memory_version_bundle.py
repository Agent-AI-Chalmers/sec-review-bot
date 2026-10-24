from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.memory.version_bundle import (
    materialize_memory_version,
    publish_memory_version,
)


def test_memory_version_round_trip(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    topics = memory / "topics"
    topics.mkdir(parents=True)
    (memory / "MEMORY.md").write_text("# Index\n", encoding="utf-8")
    (topics / "parsing.md").write_text("# Parsing\n", encoding="utf-8")

    with patch.dict("os.environ", {}, clear=True):
        reference = publish_memory_version(
            memory_content_root=memory,
            output_dir=tmp_path / "published",
            remote=False,
        )
    archive_path = tmp_path / "published" / "memory-tree.v1.tar.zst"
    with patch(
        "sec_review_agents.artifacts.materialize.download_s3_object",
        return_value=archive_path,
    ):
        materialized = materialize_memory_version(
            replace(
                reference,
                uri=f"s3://artifacts/memory/versions/{reference.digest.removeprefix('sha256:')}/memory-tree.v1.tar.zst",
            ),
            destination=tmp_path / "materialized",
        )

    assert (materialized / "MEMORY.md").read_text(encoding="utf-8") == "# Index\n"
    assert (materialized / "topics" / "parsing.md").read_text(
        encoding="utf-8"
    ) == "# Parsing\n"


def test_memory_version_digest_depends_on_content_not_mtime(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    (memory / "topics").mkdir(parents=True)
    index = memory / "MEMORY.md"
    index.write_text("# Index\n", encoding="utf-8")

    first = publish_memory_version(
        memory_content_root=memory,
        output_dir=tmp_path / "first",
        remote=False,
    )
    index.touch()
    second = publish_memory_version(
        memory_content_root=memory,
        output_dir=tmp_path / "second",
        remote=False,
    )

    assert first.digest == second.digest


def test_managed_memory_version_requires_s3_configuration(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    memory.mkdir()
    (memory / "MEMORY.md").write_text("# Index\n", encoding="utf-8")

    with (
        patch.dict("os.environ", {}, clear=True),
        pytest.raises(RuntimeError, match="SEC_REVIEW_ARTIFACT_S3_BUCKET"),
    ):
        publish_memory_version(
            memory_content_root=memory,
            output_dir=tmp_path / "published",
        )
