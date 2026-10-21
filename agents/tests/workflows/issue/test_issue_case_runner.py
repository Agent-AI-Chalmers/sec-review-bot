"""Oracle assignment behaviour that the case files cannot express on their own.

Every stored case has requirements that are disjoint or nearly so. The assignment can still be
wrong when one requirement is broader than another, and no case exercises that overlap, so these
tests construct the shapes directly.
"""

import pytest

from tests.workflows.issue.cases.models import (
    EvidenceRequirement,
    FindingRequirement,
    IssueCase,
    IssueCaseOracle,
    IssueInput,
)
from tests.workflows.issue.cases.runner import assert_issue_case_oracle


def _requirement(label: str, pattern: str) -> FindingRequirement:
    return FindingRequirement(
        label=label,
        required_evidence=[EvidenceRequirement(label=label, any_of=[pattern])],
    )


def _case(*requirements: FindingRequirement) -> IssueCase:
    return IssueCase(
        id="assignment-probe",
        issue=IssueInput(title="probe", body="probe"),
        oracle=IssueCaseOracle(
            acceptable_verdicts={"confirmed-vulnerability"},
            expected_mechanism="constructed for an assignment test",
            required_findings=list(requirements),
        ),
    )


def _finding(title: str, overview: str) -> dict[str, object]:
    return {
        "verdict": "confirmed-vulnerability",
        "title": title,
        "overview": overview,
        "locations": [{"file": "src/probe.py"}],
    }


def test_broad_requirement_first_does_not_strand_a_narrower_one() -> None:
    """A broad requirement can match every finding, while a narrow one matches a single finding.

    Taking the narrow requirement's only candidate for the broad requirement leaves the narrow
    requirement unsatisfied, even though a valid one-to-one assignment exists.
    """
    broad = _requirement("broad", "marker")
    narrow = _requirement("narrow", "alpha")

    accepted = assert_issue_case_oracle(
        _case(broad, narrow),
        {"narratives": [_finding("A", "marker alpha"), _finding("B", "marker")]},
    )

    assert {finding["title"] for finding in accepted} == {"A", "B"}


def test_narrow_requirement_first_also_assigns_every_finding() -> None:
    narrow = _requirement("narrow", "alpha")
    broad = _requirement("broad", "marker")

    accepted = assert_issue_case_oracle(
        _case(narrow, broad),
        {"narratives": [_finding("A", "marker alpha"), _finding("B", "marker")]},
    )

    assert {finding["title"] for finding in accepted} == {"A", "B"}


def test_merged_narrative_cannot_satisfy_two_requirements() -> None:
    """The property `required_findings` exists for: one narrative must not cover two defects."""
    first = _requirement("first", "marker")
    second = _requirement("second", "alpha")

    with pytest.raises(AssertionError, match="required finding"):
        assert_issue_case_oracle(
            _case(first, second),
            {"narratives": [_finding("merged", "marker alpha")]},
        )


def test_rejects_when_no_distinct_assignment_exists() -> None:
    """Both requirements can only be met by the same finding, so the run must fail."""
    first = _requirement("first", "alpha")
    second = _requirement("second", "alpha")

    with pytest.raises(AssertionError):
        assert_issue_case_oracle(
            _case(first, second),
            {"narratives": [_finding("A", "marker alpha"), _finding("B", "marker")]},
        )
