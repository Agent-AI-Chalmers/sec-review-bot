# Real-LLM regression smoke for competing issue explanations. It checks that a
# confirmed root cause can coexist with a lower-priority unresolved alternative.

import re

import pytest

from tests.integration.llm.issue_helpers import (
    ISSUE_LLM_ENABLED,
    ISSUE_LLM_SKIP_REASON,
    analyze_issue_case,
    confirmed_findings,
    narrative_text,
    non_confirmed_narratives,
)


@pytest.mark.skipif(not ISSUE_LLM_ENABLED, reason=ISSUE_LLM_SKIP_REASON)
@pytest.mark.asyncio
async def test_issue_analyzer_keeps_lower_priority_unresolved_competing_narrative() -> (
    None
):
    result = await analyze_issue_case(
        workspace_files={
            "src/server/invites.ts": "\n".join(
                [
                    "import express from 'express'",
                    "import { db } from './db'",
                    "import { makeInviteToken } from '@acme/invite-tokens'",
                    "",
                    "const router = express.Router()",
                    "",
                    "export async function createInvite(req, res) {",
                    "  const token = await makeInviteToken({ orgId: req.user.orgId })",
                    "  await db.invites.insert({",
                    "    token,",
                    "    orgId: req.user.orgId,",
                    "    role: 'member',",
                    "    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),",
                    "    redeemedAt: null,",
                    "  })",
                    "  res.json({ inviteUrl: `${process.env.APP_URL}/join?token=${token}` })",
                    "}",
                    "",
                    "router.post('/api/invites/redeem', async (req, res) => {",
                    "  const invite = await db.invites.findFirst({",
                    "    where: {",
                    "      token: String(req.body.token || ''),",
                    "      expiresAt: { gte: new Date() },",
                    "    },",
                    "  })",
                    "  if (!invite) return res.status(404).json({ error: 'invalid invite' })",
                    "",
                    "  const user = await db.users.create({",
                    "    email: String(req.body.email || ''),",
                    "    orgId: invite.orgId,",
                    "    role: invite.role,",
                    "  })",
                    "  res.json({ userId: user.id })",
                    "})",
                    "",
                    "export default router",
                    "",
                ]
            )
        },
        issue={
            "title": "Invite links may allow unexpected extra accounts",
            "body": (
                "We received a report that a single invite link was associated with "
                "several unexpected signups. The reporter also worried that our invite "
                "codes might be too easy to guess, but they did not provide token "
                "samples or a brute-force trace.\n\n"
                "Please audit the invite creation and redemption flow. If the code "
                "supports more than one explanation, keep the confirmed behavior and "
                "any unresolved token-strength concern separate instead of turning "
                "the whole report into one root cause."
            ),
        },
    )

    assert result["verdict"] in {"confirmed-vulnerability", "confirmed-defect"}
    confirmed = confirmed_findings(result)
    non_confirmed = non_confirmed_narratives(result)
    text = "\n".join(narrative_text(item) for item in confirmed)
    non_confirmed_text = "\n".join(narrative_text(item) for item in non_confirmed)

    replay_narratives = [
        item
        for item in confirmed
        if re.search(
            r"replay|one-time|one time|redeemed|reuse|multiple",
            narrative_text(item),
        )
    ]
    assert replay_narratives
    assert "redeem" in text
    assert "db.users.create" in text

    weak_token_narratives = [
        item
        for item in non_confirmed
        if re.search(
            r"makeinvitetoken|weak token|guessable|entropy|brute.?force",
            narrative_text(item),
        )
    ]
    assert weak_token_narratives
    assert re.search(
        r"proof gap|not.*repository|not.*shown|external|package|implementation|entropy",
        non_confirmed_text,
    )
