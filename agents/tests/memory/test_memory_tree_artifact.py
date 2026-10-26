import json
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.contract_versions import MEMORY_TREE_ARTIFACT_VERSION
from sec_review_agents.memory.memory_tree_artifact import (
    MEMORY_TREE_ARTIFACT_FILENAME,
    _validate_archive,
    build_memory_tree_artifact,
    materialize_memory_tree,
    publish_memory_tree_artifact,
)
from tests.project_paths import CONTRACTS_ROOT

CORPUS = (
    CONTRACTS_ROOT
    / "tar-zstd-artifact"
    / "profiles"
    / "memory-tree"
    / MEMORY_TREE_ARTIFACT_VERSION
    / "corpus"
)


def test_memory_tree_artifact_round_trip(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    topics = memory / "topics"
    topics.mkdir(parents=True)
    (memory / "MEMORY.md").write_text("# Index\n", encoding="utf-8")
    (topics / "parsing.md").write_text("# Parsing\n", encoding="utf-8")

    with patch.dict("os.environ", {}, clear=True):
        reference = publish_memory_tree_artifact(
            memory_content_root=memory,
            output_dir=tmp_path / "published",
            remote=False,
        )
    archive_path = tmp_path / "published" / MEMORY_TREE_ARTIFACT_FILENAME
    with patch(
        "sec_review_agents.artifacts.materialize.download_s3_object",
        return_value=archive_path,
    ):
        materialized = materialize_memory_tree(
            replace(
                reference,
                uri=(
                    "s3://artifacts/memory/trees/"
                    f"{reference.digest.removeprefix('sha256:')}/"
                    f"{MEMORY_TREE_ARTIFACT_FILENAME}"
                ),
            ),
            destination=tmp_path / "materialized",
        )

    assert (materialized / "MEMORY.md").read_text(encoding="utf-8") == "# Index\n"
    assert (materialized / "topics" / "parsing.md").read_text(
        encoding="utf-8"
    ) == "# Parsing\n"


def test_memory_tree_artifact_digest_depends_on_content_not_mtime(
    tmp_path: Path,
) -> None:
    memory = tmp_path / "memory"
    (memory / "topics").mkdir(parents=True)
    index = memory / "MEMORY.md"
    index.write_text("# Index\n", encoding="utf-8")

    first = publish_memory_tree_artifact(
        memory_content_root=memory,
        output_dir=tmp_path / "first",
        remote=False,
    )
    index.touch()
    second = publish_memory_tree_artifact(
        memory_content_root=memory,
        output_dir=tmp_path / "second",
        remote=False,
    )

    assert first.digest == second.digest


def test_memory_tree_artifact_requires_s3_configuration(tmp_path: Path) -> None:
    memory = tmp_path / "memory"
    memory.mkdir()
    (memory / "MEMORY.md").write_text("# Index\n", encoding="utf-8")

    with (
        patch.dict("os.environ", {}, clear=True),
        pytest.raises(RuntimeError, match="SEC_REVIEW_ARTIFACT_S3_BUCKET"),
    ):
        publish_memory_tree_artifact(
            memory_content_root=memory,
            output_dir=tmp_path / "published",
        )


def test_memory_tree_artifact_entry_limit_includes_directories(
    tmp_path: Path,
) -> None:
    memory = tmp_path / "memory"
    (memory / "topics" / "first").mkdir(parents=True)
    (memory / "topics" / "second").mkdir(parents=True)
    (memory / "MEMORY.md").write_text("# Index\n", encoding="utf-8")
    (memory / "topics" / "first" / "topic.md").write_text("# First\n", encoding="utf-8")
    (memory / "topics" / "second" / "topic.md").write_text(
        "# Second\n", encoding="utf-8"
    )

    with (
        patch(
            "sec_review_agents.memory.memory_tree_artifact.MAX_MEMORY_TREE_ARTIFACT_ENTRIES",
            7,
        ),
        pytest.raises(ValueError, match="entry count limit"),
    ):
        build_memory_tree_artifact(
            memory_content_root=memory,
            output_dir=tmp_path / "published",
        )


def test_memory_tree_artifact_supports_paths_that_require_pax(
    tmp_path: Path,
) -> None:
    memory = tmp_path / "memory"
    topics = memory / "topics"
    topics.mkdir(parents=True)
    (memory / "MEMORY.md").write_text("# Index\n", encoding="utf-8")
    (topics / ("a" * 101 + ".md")).write_text("# Topic\n", encoding="utf-8")

    reference = build_memory_tree_artifact(
        memory_content_root=memory,
        output_dir=tmp_path / "published",
    )

    _validate_archive(Path(reference.uri.removeprefix("file://")))


def test_python_reader_matches_shared_memory_tree_corpus() -> None:
    manifest = json.loads((CORPUS / "manifest.json").read_text(encoding="utf-8"))

    for fixture in manifest["corpus"]:
        archive = CORPUS / fixture["file"]
        if fixture["expected"] == "valid":
            _validate_archive(archive)
        else:
            with pytest.raises(ValueError):
                _validate_archive(archive)
