# Real-LLM regression smoke for mixed issues containing multiple independently
# confirmed vulnerabilities. The analyzer should not merge separate repair
# tracks into one narrative merely because they arrived in the same issue.

import re

import pytest

from tests.integration.llm.issue_helpers import (
    ISSUE_LLM_ENABLED,
    ISSUE_LLM_SKIP_REASON,
    analyze_issue_case,
    confirmed_narratives,
    narrative_text,
)


@pytest.mark.skipif(not ISSUE_LLM_ENABLED, reason=ISSUE_LLM_SKIP_REASON)
@pytest.mark.asyncio
async def test_issue_analyzer_keeps_independent_confirmed_claims_as_separate_narratives() -> (
    None
):
    result = await analyze_issue_case(
        workspace_files={
            "src/server/reports.ts": "\n".join(
                [
                    "import express from 'express'",
                    "import { db } from './db'",
                    "import { requireUser } from './auth'",
                    "",
                    "const router = express.Router()",
                    "",
                    "router.get('/api/reports/:id/export', requireUser, async (req, res) => {",
                    "  const report = await db.reports.findById(req.params.id)",
                    "  if (!report) return res.status(404).json({ error: 'missing report' })",
                    "  res.json({ id: report.id, confidentialNotes: report.confidentialNotes })",
                    "})",
                    "",
                    "router.get('/api/admin/debug-session', async (req, res) => {",
                    "  const session = await db.sessions.findById(String(req.query.sessionId || ''))",
                    "  res.json({",
                    "    userId: session.userId,",
                    "    csrfToken: session.csrfToken,",
                    "    oauthAccessToken: session.oauthAccessToken,",
                    "  })",
                    "})",
                    "",
                    "export default router",
                    "",
                ]
            )
        },
        issue={
            "title": "Two report-controller issues: report export IDOR and debug session token leak",
            "body": (
                "Please audit two separate security claims in `src/server/reports.ts`.\n\n"
                "Claim A: `/api/reports/:id/export` uses `requireUser`, but it appears "
                "to fetch reports by id only and returns confidential notes without checking "
                "ownership. This may let one authenticated user export another user's report.\n\n"
                "Claim B: `/api/admin/debug-session` looks unauthenticated and returns "
                "`csrfToken` plus `oauthAccessToken` for an arbitrary `sessionId`. This is "
                "not the same exploit path as Claim A; please do not merge it with the report "
                "export authorization issue.\n\n"
                "There may also be missing rate limits, but that is just a hardening request."
            ),
        },
    )

    assert result["verdict"] == "confirmed-vulnerability"
    confirmed = confirmed_narratives(result)
    assert len(confirmed) >= 2

    idor_narratives = [
        item
        for item in confirmed
        if "/api/reports/:id/export" in narrative_text(item)
        and re.search(r"idor|authorization|access control", narrative_text(item))
    ]
    token_leak_narratives = [
        item
        for item in confirmed
        if "/api/admin/debug-session" in narrative_text(item)
        and "oauthaccesstoken" in narrative_text(item)
    ]

    assert idor_narratives
    assert token_leak_narratives
    assert idor_narratives[0].get("priority") != token_leak_narratives[0].get(
        "priority"
    )
