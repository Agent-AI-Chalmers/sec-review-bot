import json
from pathlib import Path

import pytest

from sec_review_agents.runner import core


def test_validate_run_request_body_rejects_invalid_body() -> None:
    assert core.validate_run_request_body({}) == (
        "Runner run request body is missing run_id."
    )


@pytest.mark.parametrize(
    "run_id",
    [
        "run-20260628T120000Z-abcdef12",
        "run.1",
        "run_1",
        "A",
        "a" * 128,
    ],
)
def test_validate_run_id_accepts_public_slug_shape(run_id: str) -> None:
    assert core.validate_run_id(run_id) == run_id


def test_validate_run_id_rejects_empty_value_as_missing() -> None:
    assert core.validate_run_request_body({"run_id": "", "input": {}}) == (
        "Runner run request body is missing run_id."
    )


@pytest.mark.parametrize(
    "run_id",
    [
        " run-1",
        "run-1 ",
        "../run-1",
        "/tmp/run-1",
        "run/1",
        "run\\1",
        "run:1",
        "a" * 129,
    ],
)
def test_validate_run_id_rejects_path_like_or_noncanonical_values(
    run_id: str,
) -> None:
    assert core.validate_run_request_body({"run_id": run_id, "input": {}}) == (
        "Runner run_id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$."
    )


def test_public_runner_workflow_allowlist() -> None:
    assert core.SUPPORTED_RUNNER_WORKFLOWS == {
        "issue-review",
        "pull-request-review",
        "repository-review",
    }
    assert core.is_supported_workflow("issue-review") is True
    assert core.is_supported_workflow("issue-review-single-agent") is False
    assert core.is_supported_workflow("issue-review-two-stage") is False


def test_prepare_runner_input_data_derives_bundle_and_artifact_paths(
    tmp_path: Path,
) -> None:
    bundle_root = tmp_path / "bundle"
    bundle_root.mkdir()
    (bundle_root / "manifest.json").write_text(
        json.dumps(
            {
                "contract_version": "v4",
                "kind": "runner-input-bundle",
                "workspace": {"snapshot": "workspace.snapshot.tar"},
                "history": {"path": "history"},
            }
        ),
        encoding="utf-8",
    )

    prepared = core.prepare_runner_input_data(
        {
            "contract_version": "v4",
            "input_bundle_uri": str(bundle_root),
            "review_intent": {"objective": "audit"},
            "issue": {"number": 1},
        },
        run_id="run-core",
        workflow="issue-review",
    )

    assert prepared["input_bundle_root_path"] == str(bundle_root)
    assert prepared["artifact_root_path"] == str(bundle_root / "artifacts")
    assert prepared["artifact_paths"] == {
        "analyzer": str(bundle_root / "artifacts" / "analyzer"),
        "mitigator": str(bundle_root / "artifacts" / "mitigator"),
        "verifier": str(bundle_root / "artifacts" / "verifier"),
    }
    assert prepared["bundle_paths"] == {
        "workspace_snapshot_tar_path": str(bundle_root / "workspace.snapshot.tar"),
        "history_path": str(bundle_root / "history"),
    }


def test_prepare_runner_input_data_rejects_unsupported_workflow() -> None:
    with pytest.raises(ValueError, match="Unsupported workflow"):
        core.prepare_runner_input_data(
            {
                "contract_version": "v4",
                "input_bundle_uri": "/tmp/bundle",
            },
            run_id="run-core",
            workflow="issue-review-single-agent",
        )
