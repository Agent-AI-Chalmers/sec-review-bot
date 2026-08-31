import json
from pathlib import Path

import pytest

from sec_review_agents.runner.core import (
    prepare_runner_input_data,
)
from sec_review_agents.runtime.runtime_config import runtime_context_from_config


def _issue_input() -> dict:
    local_root = Path("/tmp/local-runtime-config")
    local_root.mkdir(parents=True, exist_ok=True)
    (local_root / "manifest.json").write_text(
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
    return {
        "contract_version": "v4",
        "review_intent": {"objective": "audit"},
        "issue": {"number": 1},
        "input_bundle_uri": str(local_root),
    }


def test_runner_runtime_config_is_applied_after_workflow_input_preparation(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RUNNER_ALLOW_WORKSPACE_IMAGE_OVERRIDE", "true")
    input_data = _issue_input()
    runtime = {
        "workspace_image": "benchmark-image:latest",
    }

    prepared_input = prepare_runner_input_data(
        input_data,
        run_id="run-runtime-config",
        workflow="issue-review",
    )

    assert "workspace_image" not in prepared_input
    assert "runtime_context" not in prepared_input
    assert "run_id" not in prepared_input
    runtime_context = runtime_context_from_config(runtime)
    assert runtime_context.get("workspace_image") == "benchmark-image:latest"


def test_runner_input_preparation_does_not_mutate_payload_input() -> None:
    input_data = _issue_input()

    first_input = prepare_runner_input_data(
        input_data,
        run_id="run-runtime-config",
        workflow="issue-review",
    )
    second_input = prepare_runner_input_data(
        input_data,
        run_id="run-runtime-config",
        workflow="issue-review",
    )

    assert "analyzer" in first_input["artifact_paths"]
    assert "analyzer" in second_input["artifact_paths"]
    assert "artifact_paths" not in input_data
    assert "run_id" not in input_data


def test_runner_runtime_config_rejects_workspace_image_override_by_default(
    monkeypatch,
) -> None:
    monkeypatch.delenv("RUNNER_ALLOW_WORKSPACE_IMAGE_OVERRIDE", raising=False)

    with pytest.raises(ValueError, match="override is disabled"):
        runtime_context_from_config({"workspace_image": "benchmark-image:latest"})


def test_runner_runtime_config_rejects_invalid_workspace_image(monkeypatch) -> None:
    monkeypatch.setenv("RUNNER_ALLOW_WORKSPACE_IMAGE_OVERRIDE", "true")

    with pytest.raises(ValueError, match="workspace_image"):
        runtime_context_from_config({"workspace_image": ""})

    with pytest.raises(ValueError, match="workspace_image"):
        runtime_context_from_config({"workspace_image": False})


def test_runner_runtime_config_rejects_unknown_keys() -> None:
    with pytest.raises(ValueError, match="unsupported key"):
        runtime_context_from_config({"extraRuntimeKnob": True})


def test_runner_input_rejects_caller_runtime_context() -> None:
    input_data = _issue_input()
    input_data["runtime_context"] = {
        "workspace_image": "smuggled:latest",
    }

    with pytest.raises(ValueError, match="runtime_context"):
        prepare_runner_input_data(
            input_data,
            run_id="run-runtime-config",
            workflow="issue-review",
        )


def test_runner_input_rejects_caller_run_id() -> None:
    input_data = _issue_input()
    input_data["run_id"] = "smuggled-run"

    with pytest.raises(ValueError, match="run_id"):
        prepare_runner_input_data(
            input_data,
            run_id="run-runtime-config",
            workflow="issue-review",
        )
