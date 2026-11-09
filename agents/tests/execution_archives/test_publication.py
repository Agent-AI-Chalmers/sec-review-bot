import os
from pathlib import Path
from unittest.mock import patch

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.execution_archives.bundle import ExecutionArchive
from sec_review_agents.execution_archives.publication import (
    ExecutionArchivePublicationRequest,
    publish_execution_archive_activity,
)


def test_publication_activity_uses_publisher_unit_ids(
    tmp_path: Path, monkeypatch
) -> None:
    """The activity must not re-glob trajectories and drift from the manifest."""
    empty = tmp_path / "empty"
    (empty / "0001-fake.jsonl").mkdir(parents=True)
    reference = ArtifactReference(
        uri="file:///tmp/execution-archive.v1.tar.zst",
        digest=f"sha256:{'a' * 64}",
        media_type="application/tar+zstd",
        size_bytes=42,
    )
    publication = ExecutionArchive(
        reference=reference,
        unit_ids=("case-a",),
    )
    monkeypatch.setattr(
        "sec_review_agents.execution_archives.bundle.publish_execution_archive",
        lambda **_kwargs: publication,
    )

    result = publish_execution_archive_activity(
        ExecutionArchivePublicationRequest(
            run_id="run-1",
            artifact_root_path=str(tmp_path / "artifacts"),
            review_units=[
                {"unit_id": "empty", "trajectory_root": str(empty)},
            ],
            result={},
            destination_scheme="file",
        )
    )

    assert result["unit_ids"] == ["case-a"]


def test_publication_activity_keeps_worker_storage_environment(tmp_path, monkeypatch):
    """Publishing must not supplement worker storage settings from a CLI dotenv file."""
    dotenv = tmp_path / ".env"
    dotenv.write_text(
        "AWS_ACCESS_KEY_ID=cli-key\nAWS_SECRET_ACCESS_KEY=cli-secret\n"
        "SEC_REVIEW_ARTIFACT_S3_ENDPOINT=http://local-cli.invalid\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "sec_review_agents.utils.package_paths.default_agents_env_path", lambda: dotenv
    )
    monkeypatch.setattr("sec_review_agents.utils.env._AGENTS_ENV_BOOTSTRAPPED", False)
    reference = ArtifactReference(
        uri="s3://sec-review/runs/run-1/artifacts/execution-archive.v1.tar.zst",
        digest=f"sha256:{'a' * 64}",
        media_type="application/tar+zstd",
        size_bytes=42,
    )

    def publish(**kwargs):
        assert dict(os.environ) == {"AWS_ACCESS_KEY_ID": "worker-key"}
        return ExecutionArchive(reference=reference, unit_ids=())

    monkeypatch.setattr(
        "sec_review_agents.execution_archives.bundle.publish_execution_archive",
        publish,
    )
    with patch.dict(os.environ, {"AWS_ACCESS_KEY_ID": "worker-key"}, clear=True):
        result = publish_execution_archive_activity(
            ExecutionArchivePublicationRequest(
                run_id="run-1",
                artifact_root_path=str(tmp_path),
                review_units=[],
                result={},
                destination_scheme="s3",
            )
        )
        assert dict(os.environ) == {"AWS_ACCESS_KEY_ID": "worker-key"}
    assert result["execution_archive"] == reference.as_dict()
