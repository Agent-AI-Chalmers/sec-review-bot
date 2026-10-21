"""The loader checks a case against its own workspace before any run uses it."""

import json
from pathlib import Path

import pytest

from tests.workflows.issue.cases import loader


def _write_case(root: Path, case_dir: Path, payload: dict, *, files: list[str]) -> None:
    workspace = root / case_dir / "workspace"
    workspace.mkdir(parents=True)
    for name in files:
        target = workspace / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("x = 1\n", encoding="utf-8")
    (root / case_dir / "case.json").write_text(json.dumps(payload), encoding="utf-8")


def _payload(case_id: str, *, nested_location: str) -> dict:
    return {
        "id": case_id,
        "issue": {"title": "t", "body": "b"},
        "oracle": {
            "acceptable_verdicts": ["confirmed-vulnerability"],
            "expected_mechanism": "m",
            "required_findings": [
                {
                    "label": "first",
                    "required_evidence": [{"label": "l", "any_of": ["x"]}],
                    "required_locations": [nested_location],
                }
            ],
        },
    }


def test_required_finding_locations_are_checked_against_the_workspace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A location nested inside `required_findings` must be validated like a top-level one.

    `all_locations()` exists so the nested paths are checked too. Without this test the loader
    could go back to validating only `oracle.required_locations`, and every stored case would
    still load because their nested locations happen to exist.
    """
    _write_case(
        tmp_path,
        Path("nested-missing"),
        _payload("nested-missing", nested_location="src/absent.py"),
        files=["src/present.py"],
    )
    monkeypatch.setattr(loader, "ISSUE_CASES", tmp_path)

    with pytest.raises(AssertionError, match="unknown required locations"):
        loader.load_issue_cases()
