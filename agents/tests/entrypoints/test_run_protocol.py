import pytest

from sec_review_agents.entrypoints import run_protocol


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
    with pytest.raises(ValueError) as error:
        run_protocol.validate_run_id("")
    assert str(error.value) == "Runner run request body is missing run_id."


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
    with pytest.raises(ValueError) as error:
        run_protocol.validate_run_id(run_id)
    assert str(error.value) == run_protocol.RUN_ID_REQUIREMENT_MESSAGE


def test_public_runner_workflow_allowlist() -> None:
    assert run_protocol.SUPPORTED_RUNNER_WORKFLOWS == {
        "issue-review",
        "pull-request-review",
        "repository-review",
    }
    assert run_protocol.is_supported_workflow("issue-review") is True
    assert run_protocol.is_supported_workflow("issue-review-single-agent") is False
    assert run_protocol.is_supported_workflow("issue-review-two-stage") is False
