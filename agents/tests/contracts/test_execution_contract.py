from dataclasses import replace

import pytest

from sec_review_agents.entrypoints.execution_contract import (
    EXECUTION_WORKFLOW_TYPE,
    RUN_ID_PATTERN_TEXT,
    ExecutionRequest,
    validate_execution_request,
)


def test_execution_contract_owns_temporal_workflow_type_and_envelope() -> None:
    request = ExecutionRequest(
        workflow="issue-review",
        run_id="run-contract",
        input_data={},
        timeout_seconds=60,
    )

    assert EXECUTION_WORKFLOW_TYPE == "execution-workflow"
    assert RUN_ID_PATTERN_TEXT == "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
    validate_execution_request(request)

    with pytest.raises(ValueError, match="execution-contract/v1"):
        validate_execution_request(replace(request, run_id="invalid run id"))


@pytest.mark.parametrize(
    "runtime",
    [
        "benchmark:latest",
        [],
        {"workspace_image": "   "},
        {"unknown": True},
    ],
)
def test_execution_contract_rejects_undeclared_runtime_shapes(runtime: object) -> None:
    request = ExecutionRequest(
        workflow="issue-review",
        run_id="run-runtime-contract",
        input_data={},
        timeout_seconds=60,
    )

    with pytest.raises(ValueError, match="execution-contract/v1"):
        validate_execution_request(replace(request, runtime=runtime))  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "runtime",
    [None, {}, {"workspace_image": "benchmark:latest"}],
)
def test_execution_contract_accepts_declared_runtime_shapes(runtime: object) -> None:
    request = ExecutionRequest(
        workflow="issue-review",
        run_id="run-runtime-contract",
        input_data={},
        timeout_seconds=60,
    )

    validate_execution_request(replace(request, runtime=runtime))  # type: ignore[arg-type]
