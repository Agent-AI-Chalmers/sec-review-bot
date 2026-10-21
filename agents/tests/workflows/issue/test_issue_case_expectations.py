"""Every issue case runs the worked examples stored beside it.

Each case directory holds its oracle and the examples that show it means what the case is for.
This module applies them generically: adding a case, or an example to an existing one, needs no
test code here.
"""

import pytest

from tests.workflows.issue.cases.loader import load_issue_cases
from tests.workflows.issue.cases.models import CaseExpectation
from tests.workflows.issue.cases.runner import assert_issue_case_oracle


def _examples() -> list[tuple[str, CaseExpectation]]:
    return [
        (case.id, example)
        for case in load_issue_cases()
        for example in case.expectations
    ]


@pytest.mark.parametrize(
    "case_id, example",
    _examples(),
    ids=[f"{case_id}-{example.name}" for case_id, example in _examples()],
)
def test_issue_case_expectation(case_id: str, example: CaseExpectation) -> None:
    case = next(c for c in load_issue_cases() if c.id == case_id)

    if example.expected == "rejected":
        with pytest.raises(AssertionError):
            assert_issue_case_oracle(case, example.result)
        return

    accepted = assert_issue_case_oracle(case, example.result)
    assert accepted, f"{case_id}: {example.name} expected an accepted finding"
