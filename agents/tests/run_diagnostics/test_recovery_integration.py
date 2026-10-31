"""Exercise response loss and recovery against an actual S3-compatible server."""

import os
import secrets
import shutil
from pathlib import Path
from unittest.mock import Mock

import boto3  # type: ignore[import-untyped]
import pytest
from botocore.config import Config  # type: ignore[import-untyped]

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.run_diagnostics.bundle import (
    diagnostic_bundle_s3_key,
    materialize_diagnostic_trajectory_unit,
)
from sec_review_agents.run_diagnostics.publication import (
    RunDiagnosticPublicationRequest,
    publish_run_diagnostic_activity,
)

pytestmark = pytest.mark.integration


def test_diagnostic_recovery_after_successful_put_with_lost_response(
    monkeypatch, tmp_path: Path
) -> None:
    endpoint = os.getenv("SEC_REVIEW_TEST_S3_ENDPOINT")
    bucket = os.getenv("SEC_REVIEW_TEST_S3_BUCKET")
    if not endpoint or not bucket:
        pytest.skip("S3 integration environment is not configured.")
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", bucket)
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_ENDPOINT", endpoint)
    client = boto3.client(
        "s3", endpoint_url=endpoint, config=Config(s3={"addressing_style": "path"})
    )
    cleanup_client = client
    if admin_key := os.getenv("SEC_REVIEW_TEST_S3_ADMIN_ACCESS_KEY"):
        cleanup_client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=admin_key,
            aws_secret_access_key=os.environ["SEC_REVIEW_TEST_S3_ADMIN_SECRET_KEY"],
            config=Config(s3={"addressing_style": "path"}),
        )
    storage = Mock(wraps=client)

    def put_then_disconnect(**kwargs):
        client.put_object(**kwargs)
        raise ConnectionResetError("upload response lost")

    storage.put_object.side_effect = put_then_disconnect
    monkeypatch.setattr(
        "sec_review_agents.artifacts.s3_adapter._s3_client", lambda: storage
    )
    run_id = f"diagnostic-recovery-{secrets.token_hex(8)}"
    root = tmp_path / "lost-worker"
    trajectories = root / "trajectories"
    trajectories.mkdir(parents=True)
    (trajectories / "0001.jsonl").write_text('{"event":"original"}\n', encoding="utf-8")
    request = RunDiagnosticPublicationRequest(
        run_id,
        str(root),
        [{"unit_id": "review", "trajectory_root": str(trajectories)}],
        {"ok": True},
        "s3",
    )
    try:
        with pytest.raises(ConnectionResetError):
            publish_run_diagnostic_activity(request)
        shutil.rmtree(root)
        recovered = publish_run_diagnostic_activity(request)
        assert not root.exists()
        assert recovered["unit_ids"] == ["review"]
        reference = ArtifactReference.from_mapping(recovered["diagnostic_bundle"])
        assert reference.uri == f"s3://{bucket}/{diagnostic_bundle_s3_key(run_id)}"
        unit = materialize_diagnostic_trajectory_unit(
            reference, run_id=run_id, unit_id="review", destination=tmp_path / "reader"
        )
        assert [path.read_text(encoding="utf-8") for path in unit.trajectory_paths] == [
            '{"event":"original"}\n'
        ]
        assert storage.put_object.call_count == 1
    finally:
        cleanup_client.delete_object(
            Bucket=bucket, Key=diagnostic_bundle_s3_key(run_id)
        )
