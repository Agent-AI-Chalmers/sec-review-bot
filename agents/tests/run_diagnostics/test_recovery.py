"""Recovery must use the uploaded archive after the activity loses local files."""

import hashlib
import io
import json
import shutil
import tarfile
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from sec_review_agents.run_diagnostics.publication import (
    RunDiagnosticPublicationRequest,
    publish_run_diagnostic_activity,
)


@pytest.fixture
def storage(monkeypatch):
    objects = {}
    client = Mock()

    def head_object(*, Bucket, Key):
        if Key not in objects:
            raise ClientError(
                {"ResponseMetadata": {"HTTPStatusCode": 404}}, "HeadObject"
            )
        blob, media_type, metadata = objects[Key]
        return {
            "ContentLength": len(blob),
            "ContentType": media_type,
            "Metadata": metadata,
        }

    def put_object(*, Bucket, Key, Body, ContentType, Metadata, IfNoneMatch):
        assert IfNoneMatch == "*"
        if Key in objects:
            raise ClientError(
                {"ResponseMetadata": {"HTTPStatusCode": 412}}, "PutObject"
            )
        objects[Key] = (Body.read(), ContentType, Metadata)

    client.list_objects_v2.side_effect = lambda *, Bucket, Prefix, MaxKeys: {
        "Contents": [{"Key": key} for key in sorted(objects) if key.startswith(Prefix)][
            :MaxKeys
        ]
    }
    client.head_object.side_effect = head_object
    client.put_object.side_effect = put_object
    client.get_object.side_effect = lambda *, Bucket, Key: {
        "ContentLength": len(objects[Key][0]),
        "Body": io.BytesIO(objects[Key][0]),
    }
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")
    monkeypatch.setattr(
        "sec_review_agents.artifacts.s3_adapter._s3_client", lambda: client
    )
    return client, objects


def request_for(root: Path) -> RunDiagnosticPublicationRequest:
    trajectory = root / "cases" / "case-a" / "trajectories"
    trajectory.mkdir(parents=True)
    (trajectory / "0001.jsonl").write_text('{"event":"original"}\n', encoding="utf-8")
    empty = root / "cases" / "empty" / "trajectories"
    empty.mkdir(parents=True)
    return RunDiagnosticPublicationRequest(
        run_id="run-1",
        artifact_root_path=str(root),
        review_units=[
            {"unit_id": "case-a", "trajectory_root": str(trajectory)},
            {"unit_id": "empty", "trajectory_root": str(empty)},
        ],
        result={"ok": True, "review_record": {"overview": "Original result."}},
        destination_scheme="s3",
    )


@pytest.mark.parametrize("lost_put_response", [False, True])
def test_activity_recovers_after_upload_and_loss_of_local_artifacts(
    tmp_path, storage, lost_put_response
):
    client, objects = storage
    root = tmp_path / "worker-artifacts"
    request = request_for(root)
    original_put = client.put_object.side_effect
    if lost_put_response:

        def put_then_disconnect(**kwargs):
            original_put(**kwargs)
            raise ConnectionResetError("upload response lost")

        client.put_object.side_effect = put_then_disconnect
        with pytest.raises(ConnectionResetError):
            publish_run_diagnostic_activity(request)
    else:
        publish_run_diagnostic_activity(
            request
        )  # Worker dies before Temporal records this result.
    shutil.rmtree(root)

    result = publish_run_diagnostic_activity(request)

    assert (
        not root.exists()
    ), "Recovery must not rebuild or recreate the lost worker directory."
    assert result["unit_ids"] == [
        "case-a"
    ], "Empty units stay omitted without re-globbing local paths."
    blob = next(iter(objects.values()))[0]
    reference = result["diagnostic_bundle"]
    assert reference["digest"] == f"sha256:{hashlib.sha256(blob).hexdigest()}"
    assert reference["size_bytes"] == len(blob)
    assert (
        reference["uri"]
        == "s3://sec-review/runs/run-1/artifacts/diagnostic-tree.v1.tar.zst"
    )
    assert result["artifact_storage"]["artifact"]["digest"] == reference["digest"]
    assert client.put_object.call_count == 1
    assert client.get_object.call_count == 1


@pytest.mark.parametrize(
    "changed", ["run", "result", "result_type", "unit_id", "unit_root", "omitted_unit"]
)
def test_recovery_rejects_a_bundle_that_does_not_match_the_request(
    tmp_path, storage, changed
):
    client, objects = storage
    root = tmp_path / "worker-artifacts"
    request = request_for(root)
    publish_run_diagnostic_activity(request)
    shutil.rmtree(root)
    if changed == "run":
        request = replace(request, run_id="run-2")
        old_key = next(iter(objects))
        objects[old_key.replace("run-1", "run-2")] = objects[old_key]
    elif changed == "result":
        request = replace(
            request,
            result={"ok": True, "review_record": {"overview": "Different result."}},
        )
    elif changed == "result_type":
        request.result["ok"] = 1  # Python equality alone treats 1 and True as equal.
    elif changed == "unit_id":
        request.review_units[0]["unit_id"] = "another-case"
    elif changed == "unit_root":
        request.review_units[0]["trajectory_root"] = str(root / "wrong")
    else:
        request = replace(request, review_units=[])
    with pytest.raises(ValueError, match="does not match|do not match"):
        publish_run_diagnostic_activity(request)
    assert client.put_object.call_count == 1
    assert not root.exists()


@pytest.mark.parametrize(
    "fault",
    ["listing", "forbidden", "server_error", "download", "corrupt", "oversized"],
)
def test_recovery_does_not_rebuild_when_storage_is_uncertain_or_invalid(
    tmp_path, storage, fault
):
    client, objects = storage
    root = tmp_path / "worker-artifacts"
    request = request_for(root)
    publish_run_diagnostic_activity(request)
    if fault == "listing":
        client.list_objects_v2.side_effect = ClientError(
            {"ResponseMetadata": {"HTTPStatusCode": 503}}, "ListObjectsV2"
        )
    elif fault in {"forbidden", "server_error"}:
        client.head_object.side_effect = ClientError(
            {
                "ResponseMetadata": {
                    "HTTPStatusCode": 403 if fault == "forbidden" else 500
                }
            },
            "HeadObject",
        )
    elif fault == "download":
        client.get_object.side_effect = TimeoutError("read interrupted")
    elif fault == "corrupt":
        key = next(iter(objects))
        blob, media, metadata = objects[key]
        objects[key] = (b"x" * len(blob), media, metadata)
    else:
        from unittest.mock import patch

        from sec_review_agents.run_diagnostics import bundle

        with (
            patch.object(bundle, "MAX_DIAGNOSTIC_BUNDLE_BYTES", 1),
            pytest.raises(ValueError, match="size limit"),
        ):
            publish_run_diagnostic_activity(request)
        assert client.get_object.call_count == 0
        return
    expected_error = (
        ClientError
        if fault in {"listing", "forbidden", "server_error"}
        else TimeoutError if fault == "download" else ValueError
    )
    with pytest.raises(expected_error):
        publish_run_diagnostic_activity(request)
    assert client.put_object.call_count == 1


def test_recovery_requires_the_artifact_tree_even_when_no_review_units_exist(
    tmp_path, storage
):
    client, objects = storage
    root = tmp_path / "worker-artifacts"
    request = replace(request_for(root), review_units=[])
    buffer = io.BytesIO()
    documents = {
        "manifest.json": {
            "version": 1,
            "run_id": request.run_id,
            "result": "result.json",
            "review_units": [],
        },
        "result.json": request.result,
    }
    with tarfile.open(
        fileobj=buffer, mode="w:zst", format=tarfile.PAX_FORMAT
    ) as archive:
        for name, value in documents.items():
            content = json.dumps(value).encode()
            info = tarfile.TarInfo(name)
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    blob = buffer.getvalue()
    objects["runs/run-1/artifacts/diagnostic-tree.v1.tar.zst"] = (
        blob,
        "application/tar+zstd",
        {"sha256": hashlib.sha256(blob).hexdigest(), "size-bytes": str(len(blob))},
    )
    with pytest.raises(ValueError, match="artifact tree is missing"):
        publish_run_diagnostic_activity(request)
    client.put_object.assert_not_called()


def test_exact_key_listing_does_not_reuse_a_longer_key_with_the_same_prefix(
    tmp_path, storage
):
    client, objects = storage
    request = request_for(tmp_path / "worker-artifacts")
    original = publish_run_diagnostic_activity(request)
    key = next(iter(objects))
    objects[key + ".other"] = objects.pop(key)
    recovered = publish_run_diagnostic_activity(request)
    assert recovered == original
    assert key in objects
    assert client.put_object.call_count == 2
    client.get_object.assert_not_called()


def test_recovery_rejects_same_size_replacement_between_head_and_get(tmp_path, storage):
    """Discovery is not a lock: bytes read later must match the discovered digest."""
    client, objects = storage
    request = request_for(tmp_path / "worker-artifacts")
    publish_run_diagnostic_activity(request)
    original_get = client.get_object.side_effect

    def replace_then_get(**kwargs):
        key = kwargs["Key"]
        blob, media, metadata = objects[key]
        objects[key] = (b"x" * len(blob), media, metadata)
        return original_get(**kwargs)

    client.get_object.side_effect = replace_then_get
    with pytest.raises(ValueError, match="digest does not match"):
        publish_run_diagnostic_activity(request)
    assert client.put_object.call_count == 1


def test_concurrent_publication_after_absent_listing_cannot_overwrite_winner(
    tmp_path, storage
):
    client, objects = storage
    request = request_for(tmp_path / "worker-artifacts")
    original = publish_run_diagnostic_activity(request)
    key = next(iter(objects))
    winner = objects.pop(key)
    original_put = client.put_object.side_effect

    def concurrent_winner(**kwargs):
        objects[key] = winner
        return original_put(**kwargs)

    client.put_object.side_effect = concurrent_winner
    replay = publish_run_diagnostic_activity(request)
    assert replay == original
    assert objects[key] == winner
    assert client.put_object.call_count == 2
