# Real-LLM regression smoke for mixed issue reports containing one supported vulnerability plus
# unsupported or hardening-only claims.
#
# The case oracle requires the supported finding and the case directory documents the unsupported
# claims in its expectations; this module asserts that neither grows into a confirmed narrative.

import re

import pytest

from tests.workflows.issue.cases.loader import load_issue_cases
from tests.workflows.issue.cases.runner import assert_issue_case_oracle
from tests.workflows.issue.llm_helpers import (
    ISSUE_LLM_ENABLED,
    ISSUE_LLM_SKIP_REASON,
    analyze_issue_case,
    confirmed_narratives,
    confirmed_text,
)

pytestmark = [pytest.mark.integration, pytest.mark.llm]

CASE_ID = "report-export-idor-with-unsupported-claims"
CASE = next(case for case in load_issue_cases() if case.id == CASE_ID)


@pytest.mark.skipif(not ISSUE_LLM_ENABLED, reason=ISSUE_LLM_SKIP_REASON)
@pytest.mark.asyncio
async def test_issue_analyzer_keeps_confirmed_idor_separate_from_unsupported_claims() -> (
    None
):
    result = await analyze_issue_case(
        workspace_files=CASE.load_workspace_files(),
        issue=CASE.issue.model_dump(),
    )

    assert_issue_case_oracle(CASE, result)
    assert confirmed_narratives(result)

    text = confirmed_text(result)
    assert not re.search(r"sql injection|sqli|query injection", text)
    assert not re.search(r"rate limit|rate-limit|denial of service|dos", text)
