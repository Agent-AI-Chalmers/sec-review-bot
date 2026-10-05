from pathlib import Path
from unittest.mock import MagicMock, patch

from sec_review_agents.artifacts.run_storage import publish_run_artifacts


def test_publish_run_artifacts_builds_immutable_reference(
    tmp_path: Path, monkeypatch
) -> None:
    root = tmp_path / "run"
    root.mkdir()
    (root / "transcript.txt").write_text("diagnostic", encoding="utf-8")
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_ENDPOINT", "http://rustfs.test")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "publisher")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")
    client = MagicMock()
    with patch(
        "sec_review_agents.artifacts.run_storage.boto3.client", return_value=client
    ):
        reference = publish_run_artifacts(root, "run-1")

    assert reference is not None
    assert (
        reference["uri"]
        == "s3://sec-review/runs/run-1/artifacts/diagnostic-tree.v1.tar.zst"
    )
    request = client.put_object.call_args.kwargs
    assert request["IfNoneMatch"] == "*"
    assert len(request["Metadata"]["sha256"]) == 64
    assert request["Metadata"]["size-bytes"].isdigit()


def test_publish_run_artifacts_skips_missing_terminal_tree(tmp_path: Path) -> None:
    assert publish_run_artifacts(tmp_path / "missing", "run-missing") is None


def test_publish_run_artifacts_does_not_hide_upload_failure(
    tmp_path: Path, monkeypatch
) -> None:
    root = tmp_path / "run"
    root.mkdir()
    (root / "diagnostic.txt").write_text("failure", encoding="utf-8")
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_ENDPOINT", "http://rustfs.test")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "publisher")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")
    client = MagicMock()
    client.put_object.side_effect = RuntimeError("storage unavailable")
    with patch(
        "sec_review_agents.artifacts.run_storage.boto3.client", return_value=client
    ):
        try:
            publish_run_artifacts(root, "run-failed")
        except RuntimeError as error:
            assert str(error) == "storage unavailable"
        else:
            raise AssertionError("publication failure must be raised")
