import os
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

import pytest
from temporalio import workflow
from temporalio.common import RetryPolicy

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.execution_archives.models import ExecutionArchive
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
        uri=(tmp_path / "artifacts/published/execution-archive.v1.tar.zst").as_uri(),
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

    assert result.unit_ids == ("case-a",)


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
    assert result.reference == reference


@pytest.mark.asyncio
async def test_publication_result_roundtrip_keeps_existing_reference_model() -> None:
    from temporalio import activity
    from temporalio.contrib.pydantic import pydantic_data_converter

    value = ExecutionArchive(
        reference=ArtifactReference(
            uri="file:///tmp/execution-archive.v1.tar.zst",
            digest=f"sha256:{'a' * 64}",
            media_type="application/tar+zstd",
            size_bytes=42,
        ),
        unit_ids=("case-a",),
    )
    definition = activity._Definition.must_from_callable(
        publish_execution_archive_activity
    )
    assert definition.ret_type is not None
    encoded = await pydantic_data_converter.encode([value])
    restored = (await pydantic_data_converter.decode(encoded, [definition.ret_type]))[0]
    assert restored == value
    assert isinstance(restored.reference, ArtifactReference)


@pytest.mark.parametrize(
    ("uri", "scheme", "media_type", "size"),
    [
        (
            "s3://sec-review/runs/other/artifacts/execution-archive.v1.tar.zst",
            "s3",
            "application/tar+zstd",
            42,
        ),
        (
            "s3://user@sec-review/runs/run-1/artifacts/execution-archive.v1.tar.zst",
            "s3",
            "application/tar+zstd",
            42,
        ),
        (
            "s3://sec-review:9000/runs/run-1/artifacts/execution-archive.v1.tar.zst",
            "s3",
            "application/tar+zstd",
            42,
        ),
        (
            "file:///tmp/other/published/execution-archive.v1.tar.zst",
            "file",
            "application/tar+zstd",
            42,
        ),
        ("file:///tmp/execution-archive.v1.tar.zst", "s3", "application/tar+zstd", 42),
        (
            "s3://sec-review/runs/run-1/artifacts/execution-archive.v1.tar.zst",
            "s3",
            "application/zstd",
            42,
        ),
        (
            "s3://sec-review/runs/run-1/artifacts/execution-archive.v1.tar.zst",
            "s3",
            "application/tar+zstd",
            2**53,
        ),
    ],
)
def test_invalid_publication_is_non_retryable(
    tmp_path, monkeypatch, uri, scheme, media_type, size
):
    from temporalio.exceptions import ApplicationError

    publication = ExecutionArchive(
        ArtifactReference(uri, f"sha256:{'a' * 64}", media_type, size), ()
    )
    monkeypatch.setattr(
        "sec_review_agents.execution_archives.bundle.publish_execution_archive",
        lambda **_kwargs: publication,
    )
    with pytest.raises(ApplicationError) as caught:
        publish_execution_archive_activity(
            ExecutionArchivePublicationRequest("run-1", str(tmp_path), [], {}, scheme)
        )
    assert caught.value.type == "ARTIFACT_REFERENCE_INVALID"
    assert caught.value.non_retryable is True


def test_transient_publication_failure_retains_retry_behavior(tmp_path, monkeypatch):
    error = ConnectionResetError("upload interrupted")

    def publish(**kwargs):
        raise error

    monkeypatch.setattr(
        "sec_review_agents.execution_archives.bundle.publish_execution_archive", publish
    )
    with pytest.raises(ConnectionResetError) as caught:
        publish_execution_archive_activity(
            ExecutionArchivePublicationRequest("run-1", str(tmp_path), [], {}, "s3")
        )
    assert caught.value is error


@workflow.defn(sandboxed=False)
class PublicationProbe:
    @workflow.run
    async def run(self, request: ExecutionArchivePublicationRequest) -> None:
        await workflow.execute_activity(
            publish_execution_archive_activity,
            request,
            schedule_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )


@pytest.mark.asyncio
async def test_temporal_does_not_retry_invalid_publication(tmp_path, monkeypatch):
    import asyncio
    import uuid
    from concurrent.futures import ThreadPoolExecutor

    from temporalio.client import WorkflowFailureError
    from temporalio.worker import Worker

    from tests.temporal_test_utils import temporal_time_skipping_environment

    calls = []

    def publish(**kwargs):
        calls.append(kwargs)
        return ExecutionArchive(
            ArtifactReference(
                "s3://sec-review/runs/other/artifacts/execution-archive.v1.tar.zst",
                f"sha256:{'a' * 64}",
                "application/tar+zstd",
                42,
            ),
            (),
        )

    monkeypatch.setattr(
        "sec_review_agents.execution_archives.bundle.publish_execution_archive", publish
    )
    queue = f"invalid-publication-{uuid.uuid4()}"
    async with temporal_time_skipping_environment() as env:
        with ThreadPoolExecutor(max_workers=1) as executor:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[PublicationProbe],
                activities=[publish_execution_archive_activity],
                activity_executor=executor,
            ):
                with pytest.raises(WorkflowFailureError) as caught:
                    await asyncio.wait_for(
                        env.client.execute_workflow(
                            PublicationProbe.run,
                            ExecutionArchivePublicationRequest(
                                "run-1", str(tmp_path), [], {}, "s3"
                            ),
                            id=queue,
                            task_queue=queue,
                        ),
                        timeout=15,
                    )
    assert len(calls) == 1
    assert caught.value.cause is not None
    cause = caught.value.cause.__cause__
    assert cause is not None
    from temporalio.exceptions import ApplicationError

    assert isinstance(cause, ApplicationError)
    assert cause.type == "ARTIFACT_REFERENCE_INVALID"
    assert cause.non_retryable is True
