"""Every issue case runs the worked examples stored beside it.

Each case directory holds its oracle and the examples that show it means what the case is for.
This module applies them generically: adding a case, or an example to an existing one, needs no
test code here.
"""

import pytest

from tests.workflows.issue.cases.loader import load_issue_cases
from tests.workflows.issue.cases.models import CaseExpectation, IssueCase
from tests.workflows.issue.cases.runner import assert_issue_case_oracle

CASES_BY_ID: dict[str, IssueCase] = {case.id: case for case in load_issue_cases()}
EXAMPLES: list[tuple[IssueCase, CaseExpectation]] = [
    (case, example) for case in CASES_BY_ID.values() for example in case.expectations
]


@pytest.mark.parametrize(
    "case, example",
    EXAMPLES,
    ids=[f"{case.id}-{example.name}" for case, example in EXAMPLES],
)
def test_issue_case_expectation(case: IssueCase, example: CaseExpectation) -> None:

    if example.expected == "rejected":
        with pytest.raises(AssertionError):
            assert_issue_case_oracle(case, example.result)
        return

    accepted = assert_issue_case_oracle(case, example.result)
    assert accepted, f"{case.id}: {example.name} expected an accepted finding"
