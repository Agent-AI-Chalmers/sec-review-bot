import json
import subprocess
from pathlib import Path

import pytest

from sec_review_agents.cli.local_materialization.pull_request import (
    build_local_pull_request_bundle,
)
from sec_review_agents.entrypoints.contract_schema import validate_v6_workflow_input


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


@pytest.fixture
def git_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "source"
    repo.mkdir()
    _git(repo, "init")
    _git(repo, "config", "user.name", "Test User")
    _git(repo, "config", "user.email", "test@example.com")
    (repo / "app.py").write_text("value = 1\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-m", "base")
    (repo / "app.py").write_text("value = 2\n", encoding="utf-8")
    _git(repo, "commit", "-am", "head")
    return repo


def test_local_pull_request_bundle_passes_the_v6_input_schema(
    git_repo: Path, tmp_path: Path
) -> None:
    """A local PR run starts the same workflow the GitHub path starts.

    The runner validates input against the v6 schema before the workflow runs, and that schema
    forbids additional properties. A locally materialized bundle that carried extra identity
    fields, or that omitted the review window, would fail every local run at startup -- which is
    invisible to a test that only checks the bundle was written.
    """
    bundle = build_local_pull_request_bundle(
        repo_path=git_repo,
        title="Local change",
        body="body",
        pr_number=1,
        repo_full_name_value="octo/demo",
        output_dir=tmp_path / "out",
        base_ref="HEAD~1",
    )

    validate_v6_workflow_input(bundle.input, "pull-request-review")
    input_data = bundle.input

    review_window = input_data["pr"]["review_window"]
    assert review_window["kind"] == "full"
    assert review_window["base_sha"] == input_data["pr"]["base_sha"]
    assert review_window["head_sha"] == input_data["pr"]["head_sha"]


def test_local_pull_request_metadata_is_the_agent_facing_subset(
    git_repo: Path, tmp_path: Path
) -> None:
    # The agent file and the execution input are different objects: the file carries only the
    # window and the commit list, matching what the GitHub producer writes to this path.
    bundle = build_local_pull_request_bundle(
        repo_path=git_repo,
        title="Local change",
        body="body",
        pr_number=1,
        repo_full_name_value="octo/demo",
        output_dir=tmp_path / "out",
        base_ref="HEAD~1",
    )

    metadata = json.loads(
        (bundle.local_root_path / "history" / "pr-metadata.json").read_text(
            encoding="utf-8"
        )
    )
    assert sorted(metadata) == ["commit_shas", "review_window"]
