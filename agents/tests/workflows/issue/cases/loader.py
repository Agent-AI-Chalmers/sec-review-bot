from pathlib import Path

from pydantic import ValidationError

from tests.workflows.issue.cases.models import IssueCase, IssueCaseExpectations

ISSUE_CASES = Path(__file__).parent


def load_issue_cases() -> tuple[IssueCase, ...]:
    cases = []
    seen_ids = set()
    for case_path in sorted(ISSUE_CASES.glob("*/case.json")):
        try:
            case = IssueCase.model_validate_json(case_path.read_text(encoding="utf-8"))
        except ValidationError as exc:
            raise AssertionError(f"invalid issue case {case_path}: {exc}") from exc
        case._directory = case_path.parent
        if case.id != case_path.parent.name:
            raise AssertionError(
                f"case id {case.id!r} must match directory {case_path.parent.name!r}"
            )
        if case.id in seen_ids:
            raise AssertionError(f"duplicate issue case id: {case.id}")
        if not case.workspace_source.is_dir():
            raise AssertionError(f"missing workspace directory for {case.id}")
        if not case.load_workspace_files():
            raise AssertionError(f"empty workspace directory for {case.id}")
        missing_locations = [
            location
            for location in case.oracle.required_locations
            if not (case.workspace_source / location).is_file()
        ]
        if missing_locations:
            raise AssertionError(
                f"unknown required locations for {case.id}: {missing_locations}"
            )
        expectations_path = case_path.parent / "expectations.json"
        if not expectations_path.is_file():
            raise AssertionError(f"missing expectations.json for {case.id}")
        try:
            expectations = IssueCaseExpectations.model_validate_json(
                expectations_path.read_text(encoding="utf-8")
            )
        except ValidationError as exc:
            raise AssertionError(f"invalid expectations for {case.id}: {exc}") from exc
        case._expectations = expectations.examples
        seen_ids.add(case.id)
        cases.append(case)
    if not cases:
        raise AssertionError(f"no issue cases found under {ISSUE_CASES}")
    return tuple(cases)
