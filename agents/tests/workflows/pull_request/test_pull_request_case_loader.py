"""Loader checks: a fixture on disk must agree with what it claims to describe."""

import json
from pathlib import Path

import pytest

from tests.workflows.pull_request.cases import loader


def test_every_case_on_disk_loads() -> None:
    """The loader checks each case against its own workspace, so this fails on a drifted fixture.

    A case that names a file its workspace does not hold would otherwise surface as a confusing
    model result rather than as a fixture error.
    """
    cases = loader.load_pull_request_cases()

    assert cases
    assert {case.id for case in cases} >= {"client-auth-precedent"}


def _write_case(
    root: Path, case_id: str, directory: str, files: list[str], payload: dict
) -> None:
    case_dir = root / directory
    (case_dir / "workspace").mkdir(parents=True)
    for name in files:
        target = case_dir / "workspace" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("x = 1\n", encoding="utf-8")
    (case_dir / "case.json").write_text(json.dumps(payload), encoding="utf-8")


def _payload(case_id: str, changed: list[str], any_of: list[str]) -> dict:
    return {
        "id": case_id,
        "pull_request": {
            "title": "t",
            "body": "b",
            "base_ref": "main",
            "head_ref": "feature",
        },
        "changed_files": [
            {"path": path, "status": "added", "additions": 1, "deletions": 0}
            for path in changed
        ],
        "oracle": {"required": [{"label": "l", "any_of": any_of}]},
    }


def test_a_declared_changed_file_must_exist_in_its_workspace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A case claiming files its tree does not hold would describe a different change."""
    _write_case(
        tmp_path,
        "drifted",
        "drifted",
        files=["src/present.py"],
        payload=_payload("drifted", changed=["src/missing.py"], any_of=["x"]),
    )
    monkeypatch.setattr(loader, "PULL_REQUEST_CASES", tmp_path)

    with pytest.raises(AssertionError, match="missing from its workspace"):
        loader.load_pull_request_cases()


def test_a_case_id_must_match_its_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_case(
        tmp_path,
        "different-id",
        "directory-name",
        files=["a.py"],
        payload=_payload("different-id", changed=["a.py"], any_of=["x"]),
    )
    monkeypatch.setattr(loader, "PULL_REQUEST_CASES", tmp_path)

    with pytest.raises(AssertionError, match="must match directory"):
        loader.load_pull_request_cases()


def test_an_invalid_regular_expression_fails_at_load_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A malformed pattern must not survive until a narrative is evaluated.

    The runner applies these patterns with re.search, so an invalid one would raise only when the
    oracle runs -- after the model call in the real-LLM probe. Checking at load time reports it
    where a fixture error belongs.
    """
    _write_case(
        tmp_path,
        "bad-pattern",
        "bad-pattern",
        files=["a.py"],
        payload=_payload("bad-pattern", changed=["a.py"], any_of=["["]),
    )
    monkeypatch.setattr(loader, "PULL_REQUEST_CASES", tmp_path)

    with pytest.raises(AssertionError, match="invalid narrative pattern"):
        loader.load_pull_request_cases()


def test_a_case_without_expectations_is_a_fixture_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A case must show what its oracle means; without examples nothing pins its behaviour."""
    _write_case(
        tmp_path,
        "no-examples",
        "no-examples",
        files=["a.py"],
        payload=_payload("no-examples", changed=["a.py"], any_of=["x"]),
    )
    monkeypatch.setattr(loader, "PULL_REQUEST_CASES", tmp_path)

    with pytest.raises(AssertionError, match="missing expectations.json"):
        loader.load_pull_request_cases()
