# Real-LLM regression smoke for issues containing multiple independently confirmed
# vulnerabilities. The analyzer should not merge separate repair tracks into one narrative merely
# because they arrived in the same issue.
#
# The case oracle already requires one distinct finding per defect, so this module only asserts
# the narrative shape that requirement exists to protect.

import pytest

from tests.workflows.issue.cases.loader import load_issue_cases
from tests.workflows.issue.cases.runner import assert_issue_case_oracle
from tests.workflows.issue.llm_helpers import (
    ISSUE_LLM_ENABLED,
    ISSUE_LLM_SKIP_REASON,
    analyze_issue_case,
)

pytestmark = [pytest.mark.integration, pytest.mark.llm]

CASE_ID = "report-idor-and-debug-session-token"
CASE = next(case for case in load_issue_cases() if case.id == CASE_ID)


@pytest.mark.skipif(not ISSUE_LLM_ENABLED, reason=ISSUE_LLM_SKIP_REASON)
@pytest.mark.asyncio
async def test_issue_analyzer_keeps_independent_confirmed_claims_as_separate_narratives() -> (
    None
):
    result = await analyze_issue_case(
        workspace_files=CASE.load_workspace_files(),
        issue=CASE.issue.model_dump(),
    )

    accepted = assert_issue_case_oracle(CASE, result)

    # The oracle assigns one requirement per defect, so two accepted findings is the direct
    # evidence that the run did not merge them. Narrative priority uniqueness is already enforced
    # by `AnalysisOutput`, so asserting it here would test the schema rather than this probe.
    assert len(accepted) == 2
