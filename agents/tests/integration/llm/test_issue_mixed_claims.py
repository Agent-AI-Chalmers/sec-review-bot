# Real-LLM regression smoke for mixed issue reports containing one supported
# vulnerability plus unsupported or hardening-only claims.

import re

import pytest

from tests.integration.llm.issue_helpers import (
    ISSUE_LLM_ENABLED,
    ISSUE_LLM_SKIP_REASON,
    analyze_issue_case,
    confirmed_narratives,
    confirmed_text,
)


@pytest.mark.skipif(not ISSUE_LLM_ENABLED, reason=ISSUE_LLM_SKIP_REASON)
@pytest.mark.asyncio
async def test_issue_analyzer_keeps_confirmed_idor_separate_from_unsupported_claims() -> (
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
                    "  if (!report) {",
                    "    res.status(404).json({ error: 'missing report' })",
                    "    return",
                    "  }",
                    "  const exportBody = await buildReportExport(report)",
                    "  res.json(exportBody)",
                    "})",
                    "",
                    "router.get('/api/reports/search', requireUser, async (req, res) => {",
                    "  const query = String(req.query.q || '')",
                    "  const rows = await db.query(",
                    "    'select id, title from reports where owner_id = $1 and title ilike $2',",
                    "    [req.user.id, `%${query}%`],",
                    "  )",
                    "  res.json({ rows })",
                    "})",
                    "",
                    "async function buildReportExport(report) {",
                    "  return {",
                    "    id: report.id,",
                    "    title: report.title,",
                    "    confidentialNotes: report.confidentialNotes,",
                    "  }",
                    "}",
                    "",
                    "export default router",
                    "",
                ]
            )
        },
        issue={
            "title": "Report export security issue: auth bypass, SQL injection, and missing rate limit",
            "body": (
                "I think the reports controller has several security problems.\n\n"
                "1. `/api/reports/:id/export` lets any logged-in user export any report "
                "by changing the id in the URL. The export includes confidential notes, "
                "so this looks like an authorization bypass / IDOR.\n"
                "2. `/api/reports/search?q=...` looks like SQL injection because the "
                "query string is fed into the database search.\n"
                "3. Please also add rate limiting to both endpoints because exports may "
                "be expensive.\n\n"
                "Please audit the issue and identify which security claims are actually "
                "supported by the current code."
            ),
        },
    )

    assert result["verdict"] == "confirmed-vulnerability"
    assert confirmed_narratives(result)

    text = confirmed_text(result)
    assert "/api/reports/:id/export" in text
    assert re.search(r"idor|authorization|access control", text)
    assert "confidentialnotes" in text
    assert not re.search(r"sql injection|sqli|query injection", text)
    assert not re.search(r"rate limit|rate-limit|denial of service|dos", text)
