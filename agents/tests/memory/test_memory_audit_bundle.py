import os
import tarfile
from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.memory.audit_bundle import publish_memory_audit_bundle


def test_memory_audit_bundle_is_content_deterministic(tmp_path: Path) -> None:
    first = tmp_path / "first.jsonl"
    second = tmp_path / "second.jsonl"
    content = '{"seq":1,"event":"message"}\n'
    first.write_text(content, encoding="utf-8")
    second.write_text(content, encoding="utf-8")
    os.utime(first, (1, 1))
    os.utime(second, (2, 2))

    first_reference = publish_memory_audit_bundle(
        agent_name="memory-extractor",
        transcript_paths=[first],
        output_dir=tmp_path / "first-output",
        remote=False,
    )
    second_reference = publish_memory_audit_bundle(
        agent_name="memory-extractor",
        transcript_paths=[second],
        output_dir=tmp_path / "second-output",
        remote=False,
    )

    assert first_reference.digest == second_reference.digest
    assert first_reference.size_bytes == second_reference.size_bytes


def test_memory_audit_bundle_contains_manifest_and_jsonl(tmp_path: Path) -> None:
    transcript = tmp_path / "audit.jsonl"
    transcript.write_text('{"seq":1}\n', encoding="utf-8")

    reference = publish_memory_audit_bundle(
        agent_name="memory-maintainer",
        transcript_paths=[transcript],
        output_dir=tmp_path / "output",
        remote=False,
    )

    archive_path = Path(reference.uri.removeprefix("file://"))
    with tarfile.open(archive_path, mode="r:zst") as archive:
        assert archive.getnames() == ["manifest.json", "transcripts/0001.jsonl"]


def test_managed_memory_audit_bundle_requires_s3_configuration(
    tmp_path: Path,
) -> None:
    transcript = tmp_path / "audit.jsonl"
    transcript.write_text("{}\n", encoding="utf-8")

    with (
        patch.dict("os.environ", {}, clear=True),
        pytest.raises(RuntimeError, match="SEC_REVIEW_ARTIFACT_S3_BUCKET"),
    ):
        publish_memory_audit_bundle(
            agent_name="memory-extractor",
            transcript_paths=[transcript],
            output_dir=tmp_path / "output",
        )
