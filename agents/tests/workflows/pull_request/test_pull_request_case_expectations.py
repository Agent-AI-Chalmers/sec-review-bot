"""Every case runs the worked examples stored beside it.

Each case directory holds its oracle, its workspace, and the examples that show the oracle means
what the case is for. This module applies them generically: adding a case, or a new example to an
existing one, needs no test code here. Matcher semantics are covered without depending on any
case, and loader checks live in their own module.
"""

import pytest

from tests.workflows.pull_request.cases import loader
from tests.workflows.pull_request.cases.models import CaseExpectation
from tests.workflows.pull_request.cases.runner import accepted_narratives


def _examples() -> list[tuple[str, CaseExpectation]]:
    return [
        (case.id, example)
        for case in loader.load_pull_request_cases()
        for example in case.expectations
    ]


@pytest.mark.parametrize(
    "case_id, example",
    _examples(),
    ids=[f"{case_id}-{example.name}" for case_id, example in _examples()],
)
def test_case_expectation(case_id: str, example: CaseExpectation) -> None:
    case = next(c for c in loader.load_pull_request_cases() if c.id == case_id)

    if example.expected == "forbidden":
        with pytest.raises(AssertionError, match="forbidden"):
            accepted_narratives(case, example.result)
        return

    accepted = accepted_narratives(case, example.result)
    if example.expected == "accepted":
        assert accepted, f"{case_id}: {example.name} expected an accepted narrative"
    else:
        assert (
            not accepted
        ), f"{case_id}: {example.name} expected no accepted narrative, got {accepted}"
