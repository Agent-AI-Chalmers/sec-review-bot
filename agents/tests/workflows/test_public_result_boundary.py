from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from sec_review_agents.entrypoints.execution_api_schema import (
    validate_execution_api_result,
)
from sec_review_agents.workflows.issue.workflow import (
    build_issue_review_result_activity,
)
from sec_review_agents.workflows.pull_request.workflow import (
    build_pull_request_review_result_activity,
)
from sec_review_agents.workflows.repository import result as repository_result
from tests.contract_fixtures import contract_fixture


@pytest.mark.parametrize(
    ("builder", "workflow_name"),
    [
        (build_issue_review_result_activity, "issue-review"),
        (build_pull_request_review_result_activity, "pull-request-review"),
    ],
)
@pytest.mark.parametrize("invalid", [False, True])
def test_review_result_producer_checks_serialized_record(
    monkeypatch, builder, workflow_name, invalid
) -> None:
    """Internal model serialization must satisfy the public contract before archiving."""
    public = contract_fixture(f"{workflow_name}-result.json")
    record = public["review_record"]
    if invalid:
        record["unexpected"] = True
    monkeypatch.setattr(
        "sec_review_agents.review_stages.record.build_review_record",
        Mock(return_value=SimpleNamespace(model_dump=lambda **_kwargs: record)),
    )

    if invalid:
        with pytest.raises(ValueError, match="does not match API"):
            builder(None, None, None)
    else:
        result = builder(None, None, None)
        assert result == public
        validate_execution_api_result(result, workflow_name)


def test_repository_result_producer_rejects_contract_drift(monkeypatch) -> None:
    """A permissive internal projection must not publish an invalid public result."""
    monkeypatch.setattr(
        repository_result,
        "build_scan_summary",
        lambda **_kwargs: repository_result.ScanSummary(scanned_file_count=-1),
    )
    with pytest.raises(ValueError, match="scanned_file_count"):
        repository_result.build_repository_workflow_result(
            scan_result=None, delivery_result=None, case_results=[]
        )
