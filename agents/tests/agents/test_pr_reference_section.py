from collections.abc import Callable
from typing import Any

import pytest

from sec_review_agents.agents.analysis.pull_request import (
    build_pr_analyzer_user_prompt,
)
from sec_review_agents.agents.mitigation.pull_request import (
    build_pr_mitigation_user_prompt,
)
from sec_review_agents.agents.verification.pull_request import (
    build_pr_verification_user_prompt,
)
from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from tests.analysis_fixtures import analysis_fixture

PR: dict[str, Any] = {
    "title": "Tighten token validation",
    "body": "body",
    "base_ref": "main",
    "base_sha": "prbase0001",
    "head_ref": "feature",
    "head_sha": "prhead0002",
    "commit_shas": ["prhead0002"],
}


def _analysis() -> Any:
    return analysis_fixture(
        overview="overview", verdict="confirmed-vulnerability", narratives=[]
    )


USER_PROMPT_BUILDERS: dict[str, Callable[[], str]] = {
    "analyzer": lambda: build_pr_analyzer_user_prompt(pr=PR),
    "mitigator": lambda: build_pr_mitigation_user_prompt(
        pr=PR, retry_context=None, analysis_result=_analysis()
    ),
    "verifier": lambda: build_pr_verification_user_prompt(
        pr=PR,
        retry_context=None,
        analysis_result=_analysis(),
        mitigation_result=MitigationStageResult(overview="mitigation"),
        workspace_patch=None,
    ),
}


@pytest.mark.parametrize("role", sorted(USER_PROMPT_BUILDERS))
def test_pr_user_prompt_carries_pull_request_base_and_head(role: str) -> None:
    """The PR filesystem deltas send agents to this section for the PR-wide SHAs.

    `/history/pr-metadata.json` holds only the review window and commit list, so
    if this section stopped rendering the SHAs the agents would have no source.
    """
    prompt = USER_PROMPT_BUILDERS[role]()

    section = prompt.split("# Pull Request Reference", 1)[1].split("\n# ", 1)[0]
    assert "prbase0001" in section
    assert "prhead0002" in section


def test_pr_verifier_prompt_renders_the_workspace_patch_section() -> None:
    """The verifier filesystem prompt names this section as primary evidence.

    The patch reaches the verifier only inline, never as a mounted file, so the
    section is the agent's sole copy of what mitigation changed.
    """
    prompt = build_pr_verification_user_prompt(
        pr=PR,
        retry_context=None,
        analysis_result=_analysis(),
        mitigation_result=MitigationStageResult(overview="mitigation"),
        workspace_patch="diff --git a/a.py b/a.py\n",
    )

    section = prompt.split("# Workspace Patch", 1)[1]
    assert "diff --git a/a.py b/a.py" in section
