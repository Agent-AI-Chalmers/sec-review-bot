from collections.abc import Mapping
from typing import Any

from tests.contract_fixtures import contract_fixture


def assert_public_workflow_result(result: Mapping[str, Any]) -> None:
    assert result.get("contract_version") == "v4"


def assert_review_record_shape(review_record: Mapping[str, Any]) -> None:
    for key in (
        "analysis",
        "mitigation",
        "verification",
        "cvss",
    ):
        assert key in review_record


def test_shared_v4_issue_and_pull_request_result_fixtures_are_public_shape() -> None:
    issue_result = contract_fixture("v4", "issue-review-result.json")
    pull_request_result = contract_fixture("v4", "pull-request-review-result.json")

    assert_public_workflow_result(issue_result)
    assert_public_workflow_result(pull_request_result)
    assert_review_record_shape(issue_result["review_record"])
    assert_review_record_shape(pull_request_result["review_record"])


def test_shared_v4_repository_result_fixture_is_public_shape() -> None:
    result = contract_fixture("v4", "repository-review-result.json")

    assert_public_workflow_result(result)
    assert isinstance(result["scan_summary"], Mapping)
    assert isinstance(result["deliveries"], list)
    assert_review_record_shape(result["case_results"][0]["review_record"])


def test_shared_v4_repository_blocked_result_fixture_is_public_shape() -> None:
    result = contract_fixture("v4", "repository-review-result-blocked.json")

    assert_public_workflow_result(result)
    assert result["case_results"][0]["disposition"] == "blocked"
    assert result["deliveries"] == []
    assert_review_record_shape(result["case_results"][0]["review_record"])
