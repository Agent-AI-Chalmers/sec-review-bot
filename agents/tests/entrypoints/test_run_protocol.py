import pytest

from sec_review_agents.entrypoints import run_protocol


def test_validate_run_request_body_rejects_invalid_body() -> None:
    assert run_protocol.validate_run_request_body({}) == (
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
    assert run_protocol.validate_run_id(run_id) == run_id


def test_validate_run_id_rejects_empty_value_as_missing() -> None:
    assert run_protocol.validate_run_request_body({"run_id": "", "input": {}}) == (
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
    assert run_protocol.validate_run_request_body({"run_id": run_id, "input": {}}) == (
        "Runner run_id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$."
    )


def test_public_runner_workflow_allowlist() -> None:
    assert run_protocol.SUPPORTED_RUNNER_WORKFLOWS == {
        "issue-review",
        "pull-request-review",
        "repository-review",
    }
    assert run_protocol.is_supported_workflow("issue-review") is True
    assert run_protocol.is_supported_workflow("issue-review-single-agent") is False
    assert run_protocol.is_supported_workflow("issue-review-two-stage") is False
