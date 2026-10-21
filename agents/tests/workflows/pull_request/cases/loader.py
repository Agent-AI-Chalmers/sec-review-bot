from pathlib import Path

from pydantic import ValidationError

from tests.workflows.pull_request.cases.models import (
    PullRequestCase,
    PullRequestCaseExpectations,
)

PULL_REQUEST_CASES = Path(__file__).parent


def load_pull_request_cases() -> tuple[PullRequestCase, ...]:
    """Read and check every case on disk.

    The checks are the point of having a loader: a case that names a directory by one id, claims
    files its workspace does not hold, or repeats another case would otherwise fail later as a
    confusing agent result rather than as a fixture error.
    """
    cases: list[PullRequestCase] = []
    seen_ids: set[str] = set()
    for case_path in sorted(PULL_REQUEST_CASES.glob("*/case.json")):
        try:
            case = PullRequestCase.model_validate_json(
                case_path.read_text(encoding="utf-8")
            )
        except ValidationError as exc:
            raise AssertionError(
                f"invalid pull request case {case_path}: {exc}"
            ) from exc
        case._directory = case_path.parent
        if case.id != case_path.parent.name:
            raise AssertionError(
                f"case id {case.id!r} must match directory {case_path.parent.name!r}"
            )
        if case.id in seen_ids:
            raise AssertionError(f"duplicate pull request case id: {case.id}")
        if not case.workspace_source.is_dir():
            raise AssertionError(f"missing workspace directory for {case.id}")
        missing = [
            entry.path
            for entry in case.changed_files
            if not (case.workspace_source / entry.path).is_file()
        ]
        if missing:
            raise AssertionError(
                f"changed files declared for {case.id} are missing from its workspace: {missing}"
            )
        expectations_path = case_path.parent / "expectations.json"
        if not expectations_path.is_file():
            raise AssertionError(f"missing expectations.json for {case.id}")
        try:
            expectations = PullRequestCaseExpectations.model_validate_json(
                expectations_path.read_text(encoding="utf-8")
            )
        except ValidationError as exc:
            raise AssertionError(f"invalid expectations for {case.id}: {exc}") from exc
        case._expectations = expectations.examples
        seen_ids.add(case.id)
        cases.append(case)
    if not cases:
        raise AssertionError(f"no pull request cases found under {PULL_REQUEST_CASES}")
    return tuple(cases)


__all__ = ["PULL_REQUEST_CASES", "load_pull_request_cases"]
