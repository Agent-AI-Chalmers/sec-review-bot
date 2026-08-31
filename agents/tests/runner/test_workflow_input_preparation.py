import json
from pathlib import Path
from typing import Any

import pytest

from sec_review_agents.runner import input_preparation
from sec_review_agents.runner.input_preparation import prepare_workflow_input
from tests.contract_fixtures import contract_fixture


def test_preparation_defines_current_caller_input_allowlists() -> None:
    issue_fields = input_preparation.INPUT_ALLOWED_FIELDS_BY_WORKFLOW["issue-review"]
    pr_fields = input_preparation.INPUT_ALLOWED_FIELDS_BY_WORKFLOW[
        "pull-request-review"
    ]
    repository_fields = input_preparation.INPUT_ALLOWED_FIELDS_BY_WORKFLOW[
        "repository-review"
    ]
    assert "runtime_context" not in issue_fields
    assert "run_id" not in issue_fields
    assert "kind" not in issue_fields
    assert "materialization" not in issue_fields
    assert "artifact_paths" not in issue_fields
    assert "bundle_paths" not in issue_fields
    assert "repair_mode" not in issue_fields
    assert "repair_mode" not in pr_fields
    assert "repair_mode" not in repository_fields
    assert "review_intent" in issue_fields
    assert "review_intent" in pr_fields
    assert "review_intent" in repository_fields


def _write_bundle_manifest(local_root: str, *, incremental: bool = False) -> None:
    root = Path(local_root)
    root.mkdir(parents=True, exist_ok=True)
    manifest = {
        "contract_version": "v4",
        "kind": "runner-input-bundle",
        "workspace": {"snapshot": "workspace.snapshot.tar"},
        "history": {"path": "history"},
    }
    if incremental:
        manifest["incremental_window"] = {"path": "incremental-window"}
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


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
        "max_file_bytes": 200000,
        "paths_ignore": [],
        "incremental_changed_files": [],
    }
    scan_scope.update(overrides or {})
    return scan_scope


def _issue_input(local_root: str = "/tmp/local-issue") -> dict:
    return {
        "contract_version": "v4",
        "input_bundle_uri": local_root,
        "review_intent": {"objective": "audit"},
        "issue": {"number": 1},
    }


def _pull_request_input(local_root: str = "/tmp/local-pr") -> dict:
    return {
        "contract_version": "v4",
        "input_bundle_uri": local_root,
        "review_intent": {"objective": "audit"},
        "pr": {"number": 7, "repo_full_name": "owner/repo"},
    }


def _repository_input(local_root: str = "/tmp/local-repository") -> dict:
    return {
        "contract_version": "v4",
        "input_bundle_uri": local_root,
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

    assert prepared["input_bundle_root_path"] == "/tmp/local-issue"
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
    assert prepared["bundle_paths"]["history_path"] == "/tmp/local-issue/history"
    assert (
        prepared["bundle_paths"]["workspace_snapshot_tar_path"]
        == "/tmp/local-issue/workspace.snapshot.tar"
    )


def test_shared_v4_issue_input_fixture_prepares() -> None:
    payload = contract_fixture("v4", "issue-review-input.json")
    _write_bundle_manifest(payload["input_bundle_uri"])

    prepared = prepare_workflow_input(
        payload,
        "issue-review",
        artifact_root_path=f"{payload['input_bundle_uri']}/artifacts",
    )

    assert prepared["contract_version"] == "v4"
    assert prepared["review_intent"]["objective"] == "audit"


def test_shared_v4_pull_request_input_fixture_prepares() -> None:
    payload = contract_fixture("v4", "pull-request-review-input.json")
    _write_bundle_manifest(payload["input_bundle_uri"], incremental=True)

    prepared = prepare_workflow_input(
        payload,
        "pull-request-review",
        artifact_root_path=f"{payload['input_bundle_uri']}/artifacts",
    )

    assert prepared["contract_version"] == "v4"
    assert prepared["pr"]["number"] == 42


def test_shared_v4_repository_input_fixtures_prepare() -> None:
    full_payload = contract_fixture("v4", "repository-review-input-full.json")
    _write_bundle_manifest(full_payload["input_bundle_uri"])
    full_prepared = prepare_workflow_input(
        full_payload,
        "repository-review",
        artifact_root_path=f"{full_payload['input_bundle_uri']}/artifacts",
    )

    incremental_payload = contract_fixture(
        "v4", "repository-review-input-incremental.json"
    )
    _write_bundle_manifest(incremental_payload["input_bundle_uri"], incremental=True)
    incremental_prepared = prepare_workflow_input(
        incremental_payload,
        "repository-review",
        artifact_root_path=f"{incremental_payload['input_bundle_uri']}/artifacts",
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

    with pytest.raises(ValueError, match="input_bundle_uri must resolve under"):
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
    _write_bundle_manifest(str(outside_root))
    allowed_root.mkdir()
    symlink_root.symlink_to(outside_root, target_is_directory=True)
    monkeypatch.setenv(input_preparation.INPUT_BUNDLE_ROOT_ENV, str(allowed_root))

    with pytest.raises(ValueError, match="input_bundle_uri must resolve under"):
        prepare_workflow_input(
            _issue_input(str(symlink_root)),
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

    with pytest.raises(ValueError, match="must resolve within the input bundle"):
        prepare_workflow_input(
            _issue_input(str(bundle_root)),
            "issue-review",
            artifact_root_path=bundle_root / "artifacts",
        )


def test_workflow_input_preparation_rejects_nonlocal_file_uri() -> None:
    with pytest.raises(ValueError, match="file URI must be local"):
        prepare_workflow_input(
            _issue_input("file://bundle-host/tmp/local-issue"),
            "issue-review",
            artifact_root_path="/tmp/local-issue/artifacts",
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
        == "/tmp/local-pr/incremental-window"
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
    _write_bundle_manifest(
        payload["input_bundle_uri"], incremental=manifest_incremental
    )

    prepared = prepare_workflow_input(
        payload,
        workflow,
        artifact_root_path=Path(payload["input_bundle_uri"]) / "artifacts",
    )

    assert prepared["review_intent"]["repair_mode"] == "no-test-changes"


@pytest.mark.parametrize(
    ("payload", "workflow", "manifest_incremental", "message"),
    [
        (
            _issue_input("/tmp/local-issue-bad-repair-mode")
            | {
                "review_intent": {"objective": "repair", "repair_mode": "fixtures-only"}
            },
            "issue-review",
            False,
            "review_intent.repair_mode must be",
        ),
        (
            _pull_request_input("/tmp/local-pr-repair-objective")
            | {"review_intent": {"objective": "repair"}},
            "pull-request-review",
            True,
            "review_intent.objective must be 'audit'",
        ),
        (
            _repository_input("/tmp/local-repository-repair-objective")
            | {"review_intent": {"objective": "repair"}},
            "repository-review",
            False,
            "review_intent.objective must be 'audit'",
        ),
    ],
)
def test_workflow_input_preparation_validates_review_intent_semantics(
    payload: dict,
    workflow: str,
    manifest_incremental: bool,
    message: str,
) -> None:
    _write_bundle_manifest(
        payload["input_bundle_uri"], incremental=manifest_incremental
    )

    with pytest.raises(ValueError, match=message):
        prepare_workflow_input(
            payload,
            workflow,
            artifact_root_path=Path(payload["input_bundle_uri"]) / "artifacts",
        )


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


def test_workflow_input_preparation_uses_configured_artifact_root(monkeypatch) -> None:
    _write_bundle_manifest("/tmp/local-configured-artifacts")
    monkeypatch.setenv(
        input_preparation.ARTIFACT_ROOT_ENV,
        "/var/sec-bot/artifacts",
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

    assert (
        prepared["artifact_paths"]["analyzer"]
        == "/var/sec-bot/artifacts/run-issue/analyzer"
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
                if key != "input_bundle_uri"
            },
            "issue-review",
            "input_bundle_uri",
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
        == "/tmp/local-repository-incremental/incremental-window"
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


@pytest.mark.parametrize(
    ("config", "message"),
    [
        (_repository_scan_scope({"paths_ignore": ["dist/**", ""]}), "paths_ignore[1]"),
        (_repository_scan_scope({"paths_ignore": [123]}), "paths_ignore[0]"),
        (
            _repository_scan_scope({"incremental_changed_files": ["src/app.py"]}),
            "incremental_changed_files[0]",
        ),
        (
            _repository_scan_scope(
                {
                    "incremental_changed_files": [
                        {"path": "src/app.py", "previous_path": None}
                    ]
                }
            ),
            "incremental_changed_files[0].status",
        ),
    ],
)
def test_repository_workflow_input_preparation_rejects_malformed_scan_scope_items(
    config: dict,
    message: str,
) -> None:
    payload = _repository_input()
    payload["scan_scope"] = config
    with pytest.raises(ValueError) as error:
        prepare_workflow_input(
            payload,
            "repository-review",
            artifact_root_path="/tmp/local-repository/artifacts",
        )
    assert message in str(error.value)
