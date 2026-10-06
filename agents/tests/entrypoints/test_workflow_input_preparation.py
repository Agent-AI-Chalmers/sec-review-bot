import hashlib
import json
import tarfile
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import pytest

from sec_review_agents.entrypoints import input_preparation
from sec_review_agents.entrypoints.input_preparation import (
    prepare_run_input,
    prepare_workflow_input,
)
from tests.contract_fixtures import contract_fixture


def _write_bundle_manifest(
    local_root: str, *, incremental: bool = False
) -> dict[str, object]:
    root = Path(local_root)
    root.mkdir(parents=True, exist_ok=True)
    manifest = {
        "contract_version": "v5",
        "kind": "runner-input-bundle",
        "workspace": {"snapshot": "workspace.snapshot.tar"},
        "history": {"path": "history"},
    }
    if incremental:
        manifest["incremental_window"] = {"path": "incremental-window"}
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (root / "workspace.snapshot.tar").touch()
    (root / "history").mkdir(exist_ok=True)
    if incremental:
        (root / "incremental-window").mkdir(exist_ok=True)
    archive_path = root.with_suffix(".tar.zst")
    with tarfile.open(archive_path, mode="w:zst") as archive:
        archive.add(root / "manifest.json", arcname="manifest.json")
        archive.add(root / "workspace.snapshot.tar", arcname="workspace.snapshot.tar")
        archive.add(root / "history", arcname="history")
        if incremental:
            archive.add(root / "incremental-window", arcname="incremental-window")
    content = archive_path.read_bytes()
    return {
        "uri": archive_path.as_uri(),
        "digest": f"sha256:{hashlib.sha256(content).hexdigest()}",
        "media_type": "application/vnd.sec-review.input-bundle.v1+tar+zstd",
        "size_bytes": len(content),
    }


def _bundle_root_from_ref(reference: dict[str, object]) -> Path:
    uri = reference["uri"]
    assert isinstance(uri, str)
    return Path(unquote(urlparse(uri).path)).with_suffix("").with_suffix("")


def test_prepare_run_input_derives_bundle_and_artifact_paths(tmp_path: Path) -> None:
    bundle_root = tmp_path / "bundle"
    input_bundle = _write_bundle_manifest(str(bundle_root))
    artifact_root = tmp_path / "artifacts" / "run-input-preparation"
    run_input_root = tmp_path / "run-inputs" / "run-input-preparation"
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setenv(input_preparation.ARTIFACT_ROOT_ENV, str(tmp_path / "artifacts"))
    monkeypatch.setenv(
        input_preparation.RUN_INPUT_ROOT_ENV, str(tmp_path / "run-inputs")
    )

    try:
        prepared = prepare_run_input(
            {
                "contract_version": "v5",
                "input_bundle": input_bundle,
                "review_intent": {"objective": "audit"},
                "issue": {"number": 1},
            },
            run_id="run-input-preparation",
            workflow="issue-review",
        )
    finally:
        monkeypatch.undo()

    assert prepared["input_bundle_root_path"] == str(run_input_root)
    assert prepared["artifact_root_path"] == str(artifact_root)
    assert prepared["artifact_paths"] == {
        "analyzer": str(artifact_root / "analyzer"),
        "mitigator": str(artifact_root / "mitigator"),
        "verifier": str(artifact_root / "verifier"),
    }
    assert prepared["bundle_paths"] == {
        "workspace_snapshot_tar_path": str(run_input_root / "workspace.snapshot.tar"),
        "history_path": str(run_input_root / "history"),
    }


def test_prepare_run_input_rejects_unsupported_workflow() -> None:
    with pytest.raises(ValueError, match="Unsupported workflow"):
        prepare_run_input(
            {
                "contract_version": "v5",
                "input_bundle": {},
            },
            run_id="run-input-preparation",
            workflow="issue-review-single-agent",
        )


def _repository_scan_target(overrides: dict[str, Any] | None = None) -> dict[str, Any]:
    scan_target: dict[str, Any] = {
        "target_branch": "main",
        "default_branch": "main",
        "event_type": "manual",
        "scan_mode": "full",
        "base_sha": None,
        "head_sha": "abc123",
        "commit_shas": [],
    }
    scan_target.update(overrides or {})
    return scan_target


def _repository_scan_scope(overrides: dict[str, Any] | None = None) -> dict[str, Any]:
    scan_scope: dict[str, Any] = {
        "paths_ignore": [],
        "incremental_changed_files": [],
    }
    scan_scope.update(overrides or {})
    return scan_scope


def _issue_input(local_root: str = "/tmp/local-issue") -> dict:
    return {
        "contract_version": "v5",
        "input_bundle": _write_bundle_manifest(local_root),
        "review_intent": {"objective": "audit"},
        "issue": {"number": 1},
    }


def _pull_request_input(local_root: str = "/tmp/local-pr") -> dict:
    return {
        "contract_version": "v5",
        "input_bundle": _write_bundle_manifest(local_root, incremental=True),
        "review_intent": {"objective": "audit"},
        "pr": {"number": 7, "repo_full_name": "owner/repo"},
    }


def _repository_input(local_root: str = "/tmp/local-repository") -> dict:
    return {
        "contract_version": "v5",
        "input_bundle": _write_bundle_manifest(local_root),
        "review_intent": {"objective": "audit"},
        "scan_target": _repository_scan_target(),
        "scan_scope": _repository_scan_scope(),
    }


def test_issue_workflow_input_preparation_derives_stage_artifacts() -> None:
    _write_bundle_manifest("/tmp/local-issue")
    prepared = prepare_workflow_input(
        _issue_input(),
        "issue-review",
        artifact_root_path="/tmp/local-issue/artifacts",
    )

    assert (
        prepared["input_bundle_root_path"] == "/tmp/local-issue/artifacts/input-bundle"
    )
    assert "run_id" not in prepared
    assert prepared["artifact_root_path"] == "/tmp/local-issue/artifacts"
    assert (
        prepared["artifact_paths"]["analyzer"] == "/tmp/local-issue/artifacts/analyzer"
    )
    assert (
        prepared["artifact_paths"]["mitigator"]
        == "/tmp/local-issue/artifacts/mitigator"
    )
    assert (
        prepared["artifact_paths"]["verifier"] == "/tmp/local-issue/artifacts/verifier"
    )
    assert (
        prepared["bundle_paths"]["history_path"]
        == "/tmp/local-issue/artifacts/input-bundle/history"
    )
    assert (
        prepared["bundle_paths"]["workspace_snapshot_tar_path"]
        == "/tmp/local-issue/artifacts/input-bundle/workspace.snapshot.tar"
    )


def test_shared_v5_issue_input_fixture_prepares() -> None:
    payload = contract_fixture("v5", "issue-review-input.json")
    payload["input_bundle"] = _write_bundle_manifest(
        "/tmp/sec-review-fixtures/issue-review"
    )

    prepared = prepare_workflow_input(
        payload,
        "issue-review",
        artifact_root_path="/tmp/sec-review-fixtures/issue-review-artifacts",
    )

    assert prepared["contract_version"] == "v5"
    assert prepared["review_intent"]["objective"] == "audit"


def test_shared_v5_pull_request_input_fixture_prepares() -> None:
    payload = contract_fixture("v5", "pull-request-review-input.json")
    payload["input_bundle"] = _write_bundle_manifest(
        "/tmp/sec-review-fixtures/pull-request-review", incremental=True
    )

    prepared = prepare_workflow_input(
        payload,
        "pull-request-review",
        artifact_root_path="/tmp/sec-review-fixtures/pull-request-review-artifacts",
    )

    assert prepared["contract_version"] == "v5"
    assert prepared["pr"]["number"] == 42


def test_shared_v5_repository_input_fixtures_prepare() -> None:
    full_payload = contract_fixture("v5", "repository-review-input-full.json")
    full_payload["input_bundle"] = _write_bundle_manifest(
        "/tmp/sec-review-fixtures/repository-review-full"
    )
    full_prepared = prepare_workflow_input(
        full_payload,
        "repository-review",
        artifact_root_path="/tmp/sec-review-fixtures/repository-review-full-artifacts",
    )

    incremental_payload = contract_fixture(
        "v5", "repository-review-input-incremental.json"
    )
    incremental_payload["input_bundle"] = _write_bundle_manifest(
        "/tmp/sec-review-fixtures/repository-review-incremental", incremental=True
    )
    incremental_prepared = prepare_workflow_input(
        incremental_payload,
        "repository-review",
        artifact_root_path="/tmp/sec-review-fixtures/repository-review-incremental-artifacts",
    )

    assert full_prepared["scan_target"]["scan_mode"] == "full"
    assert incremental_prepared["scan_target"]["scan_mode"] == "incremental"


def test_workflow_input_preparation_rejects_bundle_root_outside_configured_root(
    monkeypatch, tmp_path
) -> None:
    allowed_root = tmp_path / "allowed"
    outside_root = tmp_path / "outside"
    _write_bundle_manifest(str(outside_root))
    monkeypatch.setenv(input_preparation.INPUT_BUNDLE_ROOT_ENV, str(allowed_root))

    with pytest.raises(ValueError, match="input_bundle.uri must resolve under"):
        prepare_workflow_input(
            _issue_input(str(outside_root)),
            "issue-review",
            artifact_root_path=outside_root / "artifacts",
        )


def test_workflow_input_preparation_rejects_symlink_bundle_root_escape(
    monkeypatch, tmp_path
) -> None:
    allowed_root = tmp_path / "allowed"
    outside_root = tmp_path / "outside"
    symlink_root = allowed_root / "linked"
    outside_ref = _write_bundle_manifest(str(outside_root))
    outside_uri = outside_ref["uri"]
    assert isinstance(outside_uri, str)
    allowed_root.mkdir()
    symlink_archive = symlink_root.with_suffix(".tar.zst")
    symlink_archive.symlink_to(Path(unquote(urlparse(outside_uri).path)))
    monkeypatch.setenv(input_preparation.INPUT_BUNDLE_ROOT_ENV, str(allowed_root))

    payload = _issue_input(str(outside_root))
    payload["input_bundle"] = outside_ref | {"uri": symlink_archive.as_uri()}
    with pytest.raises(ValueError, match="input_bundle.uri must resolve under"):
        prepare_workflow_input(
            payload,
            "issue-review",
            artifact_root_path=outside_root / "artifacts",
        )


def test_workflow_input_preparation_rejects_manifest_symlink_escape(
    monkeypatch, tmp_path
) -> None:
    allowed_root = tmp_path / "allowed"
    bundle_root = allowed_root / "bundle"
    outside_root = tmp_path / "outside"
    outside_root.mkdir()
    outside_tar = outside_root / "workspace.snapshot.tar"
    outside_tar.write_text("not a real tar\n", encoding="utf-8")
    _write_bundle_manifest(str(bundle_root))
    (bundle_root / "workspace.snapshot.tar").unlink(missing_ok=True)
    (bundle_root / "workspace.snapshot.tar").symlink_to(outside_tar)
    monkeypatch.setenv(input_preparation.INPUT_BUNDLE_ROOT_ENV, str(allowed_root))

    with pytest.raises(ValueError, match="contains unsafe entry"):
        prepare_workflow_input(
            _issue_input(str(bundle_root)),
            "issue-review",
            artifact_root_path=bundle_root / "artifacts",
        )


def test_workflow_input_preparation_rejects_nonlocal_file_uri() -> None:
    payload = _issue_input()
    payload["input_bundle"] = payload["input_bundle"] | {
        "uri": "file://bundle-host/tmp/local-issue.tar.zst"
    }
    with pytest.raises(ValueError, match="file URI must be local"):
        prepare_workflow_input(
            payload,
            "issue-review",
            artifact_root_path="/tmp/local-issue/artifacts",
        )


def test_workflow_input_preparation_materializes_s3_archive(
    monkeypatch, tmp_path: Path
) -> None:
    reference = _write_bundle_manifest(str(tmp_path / "source"))
    source_uri = reference["uri"]
    assert isinstance(source_uri, str)
    source_archive = Path(unquote(urlparse(source_uri).path))
    payload = _issue_input(str(tmp_path / "unused"))
    payload["input_bundle"] = reference | {
        "uri": "s3://sec-review/runs/run-1/input/input-bundle.v1.tar.zst"
    }

    def download(_uri, destination, *, expected_size, maximum_size, expected_key=None):
        assert expected_size == reference["size_bytes"]
        assert maximum_size == input_preparation.MAX_INPUT_BUNDLE_BYTES
        assert expected_key is None
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(source_archive.read_bytes())
        return destination

    monkeypatch.setattr(input_preparation, "download_s3_input_bundle", download)
    prepared = prepare_workflow_input(
        payload,
        "issue-review",
        artifact_root_path=tmp_path / "artifacts",
    )

    assert Path(prepared["bundle_paths"]["workspace_snapshot_tar_path"]).is_file()


def test_prepare_run_input_rejects_file_bundle_in_object_storage_mode(
    monkeypatch, tmp_path: Path
) -> None:
    payload = _issue_input(str(tmp_path / "bundle"))
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")
    monkeypatch.setenv(input_preparation.ARTIFACT_ROOT_ENV, str(tmp_path / "artifacts"))
    monkeypatch.setenv(input_preparation.RUN_INPUT_ROOT_ENV, str(tmp_path / "inputs"))

    with pytest.raises(ValueError, match="must use s3 in object-storage mode"):
        prepare_run_input(payload, run_id="run-1", workflow="issue-review")


def test_prepare_run_input_rejects_s3_bundle_from_another_run(
    monkeypatch, tmp_path: Path
) -> None:
    payload = _issue_input(str(tmp_path / "bundle"))
    payload["input_bundle"] = payload["input_bundle"] | {
        "uri": "s3://sec-review/runs/run-other/input/input-bundle.v1.tar.zst"
    }
    monkeypatch.setenv("SEC_REVIEW_ARTIFACT_S3_BUCKET", "sec-review")
    monkeypatch.setenv(input_preparation.ARTIFACT_ROOT_ENV, str(tmp_path / "artifacts"))
    monkeypatch.setenv(input_preparation.RUN_INPUT_ROOT_ENV, str(tmp_path / "inputs"))

    with pytest.raises(ValueError, match="does not belong to this run"):
        prepare_run_input(payload, run_id="run-1", workflow="issue-review")


def test_workflow_input_preparation_rejects_oversized_archive(
    monkeypatch, tmp_path: Path
) -> None:
    payload = _issue_input(str(tmp_path / "bundle"))
    monkeypatch.setattr(input_preparation, "MAX_INPUT_BUNDLE_BYTES", 0)

    with pytest.raises(ValueError, match="compressed size limit"):
        prepare_workflow_input(
            payload, "issue-review", artifact_root_path=tmp_path / "artifacts"
        )


def test_workflow_input_preparation_rejects_too_many_archive_entries(
    monkeypatch, tmp_path: Path
) -> None:
    payload = _issue_input(str(tmp_path / "bundle"))
    monkeypatch.setattr(input_preparation, "MAX_INPUT_BUNDLE_ENTRIES", 1)

    with pytest.raises(ValueError, match="entry count limit"):
        prepare_workflow_input(
            payload, "issue-review", artifact_root_path=tmp_path / "artifacts"
        )


def test_workflow_input_preparation_rejects_extracted_size_limit(
    monkeypatch, tmp_path: Path
) -> None:
    payload = _issue_input(str(tmp_path / "bundle"))
    monkeypatch.setattr(input_preparation, "MAX_EXTRACTED_INPUT_BUNDLE_BYTES", 0)

    with pytest.raises(ValueError, match="extracted size limit"):
        prepare_workflow_input(
            payload, "issue-review", artifact_root_path=tmp_path / "artifacts"
        )


def test_pull_request_workflow_input_preparation_derives_stage_artifacts() -> None:
    _write_bundle_manifest("/tmp/local-pr", incremental=True)
    prepared = prepare_workflow_input(
        _pull_request_input(),
        "pull-request-review",
        artifact_root_path="/tmp/local-pr/artifacts",
    )

    assert prepared["artifact_paths"]["analyzer"] == "/tmp/local-pr/artifacts/analyzer"
    assert (
        prepared["artifact_paths"]["mitigator"] == "/tmp/local-pr/artifacts/mitigator"
    )
    assert prepared["artifact_paths"]["verifier"] == "/tmp/local-pr/artifacts/verifier"
    assert (
        prepared["bundle_paths"]["incremental_window_path"]
        == "/tmp/local-pr/artifacts/input-bundle/incremental-window"
    )


@pytest.mark.parametrize(
    ("payload", "workflow", "manifest_incremental"),
    [
        (
            _issue_input("/tmp/local-issue-repair-mode")
            | {
                "review_intent": {
                    "objective": "repair",
                    "repair_mode": "no-test-changes",
                }
            },
            "issue-review",
            False,
        ),
        (
            _pull_request_input("/tmp/local-pr-repair-mode")
            | {
                "review_intent": {
                    "objective": "audit",
                    "repair_mode": "no-test-changes",
                }
            },
            "pull-request-review",
            True,
        ),
        (
            _repository_input("/tmp/local-repository-repair-mode")
            | {
                "review_intent": {
                    "objective": "audit",
                    "repair_mode": "no-test-changes",
                }
            },
            "repository-review",
            False,
        ),
    ],
)
def test_workflow_input_preparation_accepts_common_repair_mode(
    payload: dict,
    workflow: str,
    manifest_incremental: bool,
) -> None:
    prepared = prepare_workflow_input(
        payload,
        workflow,
        artifact_root_path=_bundle_root_from_ref(payload["input_bundle"]) / "artifacts",
    )

    assert prepared["review_intent"]["repair_mode"] == "no-test-changes"


def test_repository_workflow_input_preparation_derives_stage_artifacts() -> None:
    _write_bundle_manifest("/tmp/local-repository")
    prepared = prepare_workflow_input(
        _repository_input(),
        "repository-review",
        artifact_root_path="/tmp/local-repository/artifacts",
    )

    assert "manifest" not in prepared["artifact_paths"]
    assert (
        prepared["artifact_paths"]["discovery"]
        == "/tmp/local-repository/artifacts/discovery"
    )
    assert (
        prepared["artifact_paths"]["triage"] == "/tmp/local-repository/artifacts/triage"
    )
    assert (
        prepared["artifact_paths"]["cases"] == "/tmp/local-repository/artifacts/cases"
    )


def test_workflow_input_preparation_uses_configured_artifact_root(
    monkeypatch, tmp_path: Path
) -> None:
    _write_bundle_manifest("/tmp/local-configured-artifacts")
    monkeypatch.setenv(
        input_preparation.ARTIFACT_ROOT_ENV,
        str(tmp_path / "artifacts"),
    )

    payload = _issue_input("/tmp/local-configured-artifacts")
    prepared = prepare_workflow_input(
        payload,
        "issue-review",
        artifact_root_path=input_preparation.workflow_artifact_root(
            payload,
            run_id="run-issue",
        ),
    )

    assert prepared["artifact_paths"]["analyzer"] == str(
        tmp_path / "artifacts" / "run-issue" / "analyzer"
    )


def test_workflow_artifact_root_rejects_configured_root_escape(monkeypatch) -> None:
    monkeypatch.setenv(
        input_preparation.ARTIFACT_ROOT_ENV,
        "/var/sec-bot/artifacts",
    )

    with pytest.raises(ValueError, match="resolves outside"):
        input_preparation.workflow_artifact_root(
            {"input_bundle_uri": "/tmp/local-configured-artifacts"},
            run_id="../outside",
        )


@pytest.mark.parametrize(
    ("payload", "workflow", "message"),
    [
        (
            _issue_input() | {"materialization": {"local_root_path": "/tmp/legacy"}},
            "issue-review",
            "materialization",
        ),
        (
            _issue_input() | {"artifact_paths": {"analyzer": "/tmp/a"}},
            "issue-review",
            "artifact_paths",
        ),
        (
            {
                key: value
                for key, value in _issue_input().items()
                if key != "input_bundle"
            },
            "issue-review",
            "input_bundle",
        ),
    ],
)
def test_workflow_input_preparation_rejects_bad_common_shape(
    payload: dict,
    workflow: str,
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        prepare_workflow_input(
            payload,
            workflow,
            artifact_root_path="/tmp/artifacts",
        )


@pytest.mark.parametrize(
    ("payload", "workflow", "message"),
    [
        (
            _issue_input() | {"workspace_ref": "abc123"},
            "issue-review",
            "workspace_ref",
        ),
        (
            _repository_input() | {"generated_at": "2026-05-13T00:00:00Z"},
            "repository-review",
            "generated_at",
        ),
        (
            _repository_input() | {"workspace_ref": "abc123"},
            "repository-review",
            "workspace_ref",
        ),
    ],
)
def test_workflow_input_preparation_rejects_bad_workspace_fields(
    payload: dict,
    workflow: str,
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        prepare_workflow_input(
            payload,
            workflow,
            artifact_root_path="/tmp/artifacts",
        )


def test_repository_incremental_input_uses_bundle_manifest_for_incremental_window() -> (
    None
):
    _write_bundle_manifest("/tmp/local-repository-incremental", incremental=True)
    payload = _repository_input("/tmp/local-repository-incremental")
    payload["input_bundle"] = _write_bundle_manifest(
        "/tmp/local-repository-incremental", incremental=True
    )
    payload["scan_target"] = _repository_scan_target(
        {
            "scan_mode": "incremental",
            "base_sha": "base123",
            "commit_shas": ["base123", "abc123"],
        }
    )

    prepared = prepare_workflow_input(
        payload,
        "repository-review",
        artifact_root_path="/tmp/local-repository-incremental/artifacts",
    )

    assert (
        prepared["bundle_paths"]["incremental_window_path"]
        == "/tmp/local-repository-incremental/artifacts/input-bundle/incremental-window"
    )


@pytest.mark.parametrize(
    ("scan_target_patch", "message"),
    [
        ({"base_sha": None}, "base_sha"),
        ({"base_sha": "abc123"}, "base_sha must differ from head_sha"),
        ({"commit_shas": []}, "commit_shas"),
    ],
)
def test_repository_incremental_input_rejects_missing_window_fields(
    scan_target_patch: dict[str, Any],
    message: str,
) -> None:
    _write_bundle_manifest("/tmp/local-repository-incremental", incremental=True)
    payload = _repository_input("/tmp/local-repository-incremental")
    payload["scan_target"] = _repository_scan_target(
        {
            "scan_mode": "incremental",
            "base_sha": "base123",
            "commit_shas": ["abc123"],
        }
        | scan_target_patch
    )

    with pytest.raises(ValueError, match=message):
        prepare_workflow_input(
            payload,
            "repository-review",
            artifact_root_path="/tmp/local-repository-incremental/artifacts",
        )


def test_repository_incremental_input_compares_trimmed_shas() -> None:
    payload = _repository_input("/tmp/local-repository-incremental")
    payload["scan_target"] = _repository_scan_target(
        {
            "scan_mode": "incremental",
            "base_sha": " abc123 ",
            "head_sha": "abc123",
            "commit_shas": ["abc123"],
        }
    )

    with pytest.raises(ValueError, match="base_sha must differ from head_sha"):
        prepare_workflow_input(
            payload,
            "repository-review",
            artifact_root_path="/tmp/local-repository-incremental/artifacts",
        )


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        (
            "scan_target",
            _repository_scan_target({"base_sha": "base123"}),
            "base_sha",
        ),
        (
            "scan_target",
            _repository_scan_target({"commit_shas": ["abc123"]}),
            "commit_shas",
        ),
        (
            "scan_scope",
            _repository_scan_scope(
                {
                    "incremental_changed_files": [
                        {
                            "path": "src/app.py",
                            "status": "modified",
                            "previous_path": None,
                        }
                    ]
                }
            ),
            "incremental_changed_files",
        ),
    ],
)
def test_repository_full_scan_rejects_incremental_inputs(
    field: str,
    value: object,
    message: str,
) -> None:
    payload = _repository_input()
    payload[field] = value
    with pytest.raises(ValueError, match=message):
        prepare_workflow_input(
            payload,
            "repository-review",
            artifact_root_path="/tmp/local-repository/artifacts",
        )


def test_repository_workflow_input_preparation_rejects_bad_scan_target() -> None:
    payload = _repository_input()
    payload["scan_target"] = _repository_scan_target({"scan_mode": "wide"})
    with pytest.raises(ValueError, match="scan_target.scan_mode"):
        prepare_workflow_input(
            payload,
            "repository-review",
            artifact_root_path="/tmp/local-repository/artifacts",
        )


def test_repository_workflow_input_preparation_rejects_bad_event_type() -> None:
    payload = _repository_input()
    payload["scan_target"] = _repository_scan_target(
        {"event_type": "workflow_dispatch"}
    )
    with pytest.raises(ValueError, match="scan_target.event_type"):
        prepare_workflow_input(
            payload,
            "repository-review",
            artifact_root_path="/tmp/local-repository/artifacts",
        )
