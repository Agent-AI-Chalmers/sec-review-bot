import pytest

from tests.workflows.issue.cases.loader import load_issue_cases
from tests.workflows.issue.cases.runner import assert_issue_case_oracle

CASES = {case.id: case for case in load_issue_cases()}


def test_issue_case_oracle_rejects_evidence_split_across_findings() -> None:
    """A case must be established by one finding, not a union of narratives."""
    result = {
        "narratives": [
            {
                "verdict": "confirmed-vulnerability",
                "overview": "The authorization context is lost.",
                "locations": [],
            },
            {
                "verdict": "confirmed-defect",
                "overview": "The mutable queue message carries only project_id.",
                "locations": [
                    {"file": "src/api.py"},
                    {"file": "src/worker.py"},
                ],
            },
        ]
    }

    with pytest.raises(AssertionError):
        assert_issue_case_oracle(CASES["cross-stage-authorization-context"], result)


def test_issue_case_oracle_returns_matching_confirmed_defect() -> None:
    matching_defect = {
        "verdict": "confirmed-defect",
        "overview": (
            "Cancellation bypasses release, so semaphore permits are exhausted and "
            "availability is lost."
        ),
        "locations": [{"file": "src/handler.py"}],
    }
    result = {
        "narratives": [
            {
                "verdict": "confirmed-vulnerability",
                "overview": "An unrelated vulnerability.",
                "locations": [{"file": "src/other.py"}],
            },
            matching_defect,
        ]
    }

    assert assert_issue_case_oracle(CASES["cancellation-permit-leak"], result) == [
        matching_defect
    ]
