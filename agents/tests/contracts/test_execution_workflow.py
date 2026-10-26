from dataclasses import replace

import pytest

from sec_review_agents.contract_versions import EXECUTION_WORKFLOW_VERSION
from sec_review_agents.entrypoints.execution_workflow import (
    EXECUTION_WORKFLOW_TYPE,
    RUN_ID_PATTERN_TEXT,
    ExecutionWorkflowInput,
)
from sec_review_agents.entrypoints.execution_workflow_validation import (
    validate_execution_workflow_input,
)


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
    runtime: object,
) -> None:
    request = ExecutionWorkflowInput(
        workflow="issue-review",
        run_id="run-runtime-contract",
        input={},
        timeout_seconds=60,
    )

    with pytest.raises(
        ValueError, match=f"execution-workflow/{EXECUTION_WORKFLOW_VERSION}"
    ):
        validate_execution_workflow_input(replace(request, runtime=runtime))  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "runtime",
    [None, {}, {"workspace_image": "benchmark:latest"}],
)
def test_execution_workflow_input_accepts_declared_runtime_shapes(
    runtime: object,
) -> None:
    request = ExecutionWorkflowInput(
        workflow="issue-review",
        run_id="run-runtime-contract",
        input={},
        timeout_seconds=60,
    )

    validate_execution_workflow_input(replace(request, runtime=runtime))  # type: ignore[arg-type]
