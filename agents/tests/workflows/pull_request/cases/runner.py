"""Run one pull request case against a real model and check the result.

The test module keeps the pytest surface; this module owns what a case run means: materializing
the window a prompt reads, invoking the analyzer, and judging the narratives against the case
oracle. Keeping it here lets a second case reuse it without copying the setup or the assertions.
"""

import json
import re
import shutil
import subprocess
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from unittest.mock import patch

from sec_review_agents.workflows.pull_request.analysis import analyze_pull_request
from sec_review_agents.workspace.snapshots import create_workspace_snapshot_tar
from tests.workflows.pull_request.cases.models import (
    ForbiddenNarrative,
    PullRequestCase,
    PullRequestCaseOracle,
)


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def _init_window_repository(workspace: Path) -> tuple[str, str]:
    """Make the fixture workspace a real repository with a base and a head commit.

    The pull request prompts read the window with git, so a plain directory leaves the agent
    without the evidence those prompts name. An empty base commit under the fixture tree makes
    every case file an addition inside the window, matching what the declared change says.
    """
    _git(workspace, "init", "-q")
    _git(workspace, "config", "user.email", "fixture@example.test")
    _git(workspace, "config", "user.name", "fixture")
    _git(workspace, "commit", "-q", "--allow-empty", "-m", "base")
    base_sha = _git(workspace, "rev-parse", "HEAD")
    _git(workspace, "add", "-A")
    _git(workspace, "commit", "-q", "-m", "head")
    head_sha = _git(workspace, "rev-parse", "HEAD")
    return base_sha, head_sha


async def run_pull_request_case(
    case: PullRequestCase, *, run_root: Path
) -> dict[str, Any]:
    workspace = run_root / "workspace"
    history = run_root / "history"
    incremental_window = run_root / "incremental-window"
    analyzer_artifacts = run_root / "artifacts" / "analyzer"

    shutil.copytree(case.workspace_source, workspace)
    history.mkdir(parents=True)
    incremental_window.mkdir(parents=True)
    analyzer_artifacts.mkdir(parents=True)

    (incremental_window / "changed-files.json").write_text(
        json.dumps(
            {"files": [entry.model_dump() for entry in case.changed_files]},
            indent=2,
        ),
        encoding="utf-8",
    )
    base_sha, head_sha = _init_window_repository(workspace)
    # The patch is a record of the run, not prompt input, so it is exported from the repository
    # rather than written by hand and left to drift from it.
    (incremental_window / "incremental.patch").write_text(
        _git(workspace, "diff", "--no-color", f"{base_sha}...{head_sha}"),
        encoding="utf-8",
    )
    (history / "pr-metadata.json").write_text(
        json.dumps(
            {
                "review_window": {
                    "kind": "full",
                    "base_sha": base_sha,
                    "head_sha": head_sha,
                    "reason": "pull-request-scope",
                },
                "commit_shas": [head_sha],
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    snapshot_tar = run_root / "workspace.snapshot.tar"
    with patch(
        "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
        return_value="local",
    ):
        create_workspace_snapshot_tar(workspace_path=workspace, tar_path=snapshot_tar)
        return await analyze_pull_request(
            pr={
                **case.pull_request.model_dump(),
                "base_sha": base_sha,
                "head_sha": head_sha,
                "commit_shas": [head_sha],
            },
            workspace_snapshot_tar_path=snapshot_tar,
            history_path=history,
            incremental_window_path=incremental_window,
            analyzer_artifacts_path=analyzer_artifacts,
        )


def _location_files(narrative: Mapping[str, Any]) -> set[str]:
    return {
        str(location["file"])
        for location in narrative.get("locations", []) or []
        if isinstance(location, Mapping) and location.get("file")
    }


def _matches_forbidden(
    narrative: Mapping[str, Any], text: str, rule: ForbiddenNarrative
) -> bool:
    """True when the narrative has every property the rule names.

    The rule is a conjunction: a false positive and a correct finding often share a keyword, so
    only the combination identifies the wrong one.
    """
    # Patterns are regular expressions, the same as the required ones. A field that switched to
    # substring matching would force its data to follow a rule the JSON does not state.
    if any(re.search(pattern, text) is None for pattern in rule.all):
        return False
    if rule.any_of and not any(re.search(pattern, text) for pattern in rule.any_of):
        return False
    if any(re.search(pattern, text) for pattern in rule.none_of):
        return False
    if rule.files_only:
        locations = _location_files(narrative)
        if not locations or not locations <= set(rule.files_only):
            return False
    return True


def _narratives_accepted_by(
    oracle: PullRequestCaseOracle, result: Mapping[str, Any]
) -> list[dict[str, Any]]:
    """Apply the oracle to a result and return the confirmed narratives it accepts.

    Everything case-specific lives in the oracle: which verdicts count, which text a narrative
    must carry, and which shapes disqualify a run. This function only applies those rules, so a
    new case adds data rather than a branch here.
    """
    confirmed = [
        narrative
        for narrative in result.get("narratives", [])
        if isinstance(narrative, dict)
        and narrative.get("verdict") in oracle.acceptable_verdicts
    ]
    assert confirmed, result

    # Forbidden shapes are checked against every accepted-verdict narrative, not only against the
    # ones that pass the requirements below. A false positive usually fails those requirements too,
    # so filtering it out would let it pass silently -- exactly the regression these cases catch.
    for rule in oracle.forbidden:
        offenders = [
            narrative
            for narrative in confirmed
            if _matches_forbidden(
                narrative, json.dumps(narrative, sort_keys=True).lower(), rule
            )
        ]
        assert (
            not offenders
        ), f"a narrative matched forbidden {rule.label!r}: {offenders}"

    return [
        narrative
        for narrative in confirmed
        if all(
            any(
                re.search(pattern, json.dumps(narrative, sort_keys=True).lower())
                for pattern in requirement.any_of
            )
            for requirement in oracle.required
        )
    ]


def accepted_narratives(
    case: PullRequestCase, result: Mapping[str, Any]
) -> list[dict[str, Any]]:
    return _narratives_accepted_by(case.oracle, result)


__all__ = [
    "accepted_narratives",
    "run_pull_request_case",
]
