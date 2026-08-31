from sec_review_agents.runner.core import is_supported_workflow


def test_issue_review_two_stage_is_not_public_runner_workflow() -> None:
    assert not is_supported_workflow("issue-review-two-stage")
