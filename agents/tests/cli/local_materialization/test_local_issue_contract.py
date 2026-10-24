import json
import subprocess
from pathlib import Path

import pytest

from sec_review_agents.cli.local_materialization.issue import build_local_issue_bundle
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
    return repo


def test_local_issue_bundle_passes_the_v6_input_schema(
    git_repo: Path, tmp_path: Path
) -> None:
    """A local issue run starts the same workflow the GitHub path starts.

    Input preparation validates input against the v6 schema, which forbids additional properties, so a
    bundle carrying extra identity fields would fail every local run at startup -- invisible to
    a test that only checks the bundle was written.
    """
    bundle = build_local_issue_bundle(
        repo_path=git_repo,
        title="Local issue",
        body="body",
        issue_number=1,
        repo_full_name_value="octo/demo",
        output_dir=tmp_path / "out",
    )

    validate_v6_workflow_input(bundle.input, "issue-review")

    assert sorted(bundle.input["issue"]) == [
        "body",
        "number",
        "owner",
        "repo",
        "repo_full_name",
        "title",
    ]


def test_local_issue_metadata_matches_the_execution_input(
    git_repo: Path, tmp_path: Path
) -> None:
    # The file on disk and the execution input are the same object for issue runs; only the pull
    # request path narrows the file for the agent.
    bundle = build_local_issue_bundle(
        repo_path=git_repo,
        title="Local issue",
        body="body",
        issue_number=1,
        repo_full_name_value="octo/demo",
        output_dir=tmp_path / "out",
    )

    metadata = json.loads(
        (bundle.local_root_path / "history" / "issue-metadata.json").read_text(
            encoding="utf-8"
        )
    )
    assert metadata == bundle.input["issue"]
