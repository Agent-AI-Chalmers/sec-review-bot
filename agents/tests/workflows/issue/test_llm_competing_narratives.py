# Real-LLM regression smoke for competing issue explanations. It checks that a confirmed root
# cause can coexist with a lower-priority unresolved alternative.
#
# The workspace and the issue text live in the case directory; this module only states what the
# competing-narrative shape requires on top of the case oracle.

import re

import pytest

from tests.workflows.issue.cases.loader import load_issue_cases
from tests.workflows.issue.cases.runner import assert_issue_case_oracle
from tests.workflows.issue.llm_helpers import (
    ISSUE_LLM_ENABLED,
    ISSUE_LLM_SKIP_REASON,
    analyze_issue_case,
    confirmed_findings,
    narrative_text,
    non_confirmed_narratives,
)

pytestmark = [pytest.mark.integration, pytest.mark.llm]

CASE_ID = "invite-replay-and-weak-token"
CASE = next(case for case in load_issue_cases() if case.id == CASE_ID)


@pytest.mark.skipif(not ISSUE_LLM_ENABLED, reason=ISSUE_LLM_SKIP_REASON)
@pytest.mark.asyncio
async def test_issue_analyzer_keeps_lower_priority_unresolved_competing_narrative() -> (
    None
):
    result = await analyze_issue_case(
        workspace_files=CASE.load_workspace_files(),
        issue=CASE.issue.model_dump(),
    )

    assert_issue_case_oracle(CASE, result)

    confirmed = confirmed_findings(result)
    non_confirmed = non_confirmed_narratives(result)
    text = "\n".join(narrative_text(item) for item in confirmed)
    non_confirmed_text = "\n".join(narrative_text(item) for item in non_confirmed)

    # The confirmed finding must stay the redemption-path defect; the weak-token hypothesis may
    # only survive as an unresolved alternative, never as a second confirmation.
    assert re.search(r"redeem", text)
    weak_token_confirmed = [
        item
        for item in confirmed
        if re.search(
            r"makeinvitetoken|weak token|guessable|entropy|brute.?force",
            narrative_text(item),
        )
    ]
    assert not weak_token_confirmed

    weak_token_alternatives = [
        item
        for item in non_confirmed
        if re.search(
            r"makeinvitetoken|weak token|guessable|entropy|brute.?force",
            narrative_text(item),
        )
    ]
    assert weak_token_alternatives
    assert re.search(
        r"proof gap|not.*repository|not.*shown|external|package|implementation|entropy",
        non_confirmed_text,
    )
