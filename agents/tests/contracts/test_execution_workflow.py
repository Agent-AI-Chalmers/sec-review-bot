from dataclasses import replace

import pytest
from pydantic import JsonValue

from sec_review_agents.contract_versions import EXECUTION_WORKFLOW_VERSION
from sec_review_agents.entrypoints.execution_workflow import (
    EXECUTION_WORKFLOW_TYPE,
    RUN_ID_PATTERN_TEXT,
    ExecutionRuntimeConfig,
    ExecutionWorkflowInput,
)
from sec_review_agents.entrypoints.execution_workflow_validation import (
    parse_execution_workflow_input,
    validate_execution_workflow_input,
)
from tests.contract_fixtures import (
    execution_workflow_fixture,
    execution_workflow_fixture_files,
    execution_workflow_fixture_manifest,
)


def test_execution_workflow_fixture_manifest_covers_every_fixture() -> None:
    manifest = execution_workflow_fixture_manifest()
    declared = set(manifest["valid"]) | set(manifest["invalid"])
    actual = {
        path.name
        for path in execution_workflow_fixture_files()
        if path.name != "manifest.json"
    }

    assert set(manifest["valid"]).isdisjoint(manifest["invalid"])
    assert declared == actual


def test_execution_workflow_shared_fixtures_match_worker_validation() -> None:
    manifest = execution_workflow_fixture_manifest()
    for name in manifest["valid"]:
        parse_execution_workflow_input(execution_workflow_fixture(name))
    for name in manifest["invalid"]:
        with pytest.raises(
            ValueError, match=f"execution-workflow/{EXECUTION_WORKFLOW_VERSION}"
        ):
            parse_execution_workflow_input(execution_workflow_fixture(name))


def test_execution_workflow_input_owns_temporal_workflow_type() -> None:
    request = ExecutionWorkflowInput(
        workflow="issue-review",
        run_id="run-contract",
        input={},
        timeout_seconds=60,
    )

    assert EXECUTION_WORKFLOW_TYPE == "execution-workflow"
    assert RUN_ID_PATTERN_TEXT == "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
    validate_execution_workflow_input(request)

    with pytest.raises(
        ValueError, match=f"execution-workflow/{EXECUTION_WORKFLOW_VERSION}"
    ):
        validate_execution_workflow_input(replace(request, run_id="invalid run id"))


@pytest.mark.parametrize(
    "runtime",
    [
        "benchmark:latest",
        [],
        {"workspace_image": "   "},
        {"unknown": True},
    ],
)
def test_execution_workflow_input_rejects_undeclared_runtime_shapes(
    runtime: JsonValue,
) -> None:
    with pytest.raises(
        ValueError, match=f"execution-workflow/{EXECUTION_WORKFLOW_VERSION}"
    ):
        parse_execution_workflow_input(
            {
                "workflow": "issue-review",
                "run_id": "run-runtime-contract",
                "input": {},
                "timeout_seconds": 60,
                "runtime": runtime,
            }
        )


@pytest.mark.parametrize(
    "runtime",
    [None, {}, {"workspace_image": "benchmark:latest"}],
)
def test_execution_workflow_input_accepts_declared_runtime_shapes(
    runtime: ExecutionRuntimeConfig | None,
) -> None:
    request = ExecutionWorkflowInput(
        workflow="issue-review",
        run_id="run-runtime-contract",
        input={},
        timeout_seconds=60,
    )

    validate_execution_workflow_input(replace(request, runtime=runtime))
