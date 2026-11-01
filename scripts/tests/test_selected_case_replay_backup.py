from pathlib import Path

import pytest
from scripts.replay.repository_selected_cases import _backup


@pytest.mark.parametrize("layout", ["nested", "external", "same"])
def test_backup_preserves_results_and_case_artifacts(tmp_path: Path, layout: str):
    run = tmp_path / "run"
    artifacts = {
        "nested": run / "artifacts" / "run",
        "external": tmp_path / "external",
        "same": run,
    }[layout]
    run.mkdir()
    artifacts.mkdir(parents=True, exist_ok=True)
    (run / "repository-review-result.json").write_text("run-result")
    (artifacts / "repository-review-result.json").write_text("artifact-result")
    case = artifacts / "cases" / "a"
    case.mkdir(parents=True)
    (case / "evidence.txt").write_text("evidence")
    backup = _backup(run_root=run, run_artifacts=artifacts, case_ids=["a"])
    assert (backup / "run" / "repository-review-result.json").read_text() == (
        "artifact-result" if layout == "same" else "run-result"
    )
    assert (
        backup / "artifacts" / "repository-review-result.json"
    ).read_text() == "artifact-result"
    assert (
        backup / "artifacts" / "cases" / "a" / "evidence.txt"
    ).read_text() == "evidence"
