import assert from 'node:assert/strict'
import test from 'node:test'

import { renderIssueReviewCommentFromReviewRecord } from '../../../src/reviews/issues/renderer.js'
import type { ReviewRecord } from '../../../src/reviews/review-record.js'

function reviewRecord(): ReviewRecord {
  return {
    analysis: {
      verdict: 'confirmed-defect',
      overview: 'Analyzer overview text.',
      narratives: []
    },
    mitigation: {
      overview: 'Mitigation overview text.',
      file_changes: [{ path: 'src/app.ts', status: 'deleted' }],
      patch_diff: null
    },
    verification: {
      overview: 'Verifier overview text.',
      review_target_claim: 'reviewed claim',
      validation_level: 'logic-simulated',
      patch_coverage: 'full',
      regression_status: 'not-run',
      resolution_next_step: 'none',
      patch_findings: [],
      verification_findings: [],
      residual_risks: []
    },
    cvss: null
  } as ReviewRecord
}

test('promoted issue comment uses the shared status vocabulary and keeps the overview', () => {
  // The promoted comment used to print its own label set, including a
  // `**Verification:**` line that actually carried patch coverage. Sharing the
  // status lines with the PR review comment removes that mislabel and keeps the
  // surfaces comparable.
  const body = renderIssueReviewCommentFromReviewRecord({
    issue: { issue_number: 42 },
    review_record: reviewRecord(),
    draftPrPlan: null,
    draftPullRequest: { number: 97, html_url: 'https://example.test/pull/97' }
  })

  assert.match(body, /^## Issue Security Review$/m)
  assert.match(body, /- Analysis: `confirmed security defect`/)
  assert.match(body, /- Mitigation: `patch proposed, 1 file changed`/)
  assert.match(
    body,
    /- Verification: `full coverage; logic simulation; checks not run`/
  )
  assert.match(body, /Analyzer overview text\./)
  assert.match(body, /PR: #97 \(https:\/\/example\.test\/pull\/97\)/)
  assert.doesNotMatch(body, /\*\*Verification:\*\*/)
})

test('unpromoted issue comment shares the same status vocabulary and reports the plan', () => {
  const body = renderIssueReviewCommentFromReviewRecord({
    issue: { issue_number: 42 },
    review_record: reviewRecord(),
    draftPrPlan: { patch_ready: true },
    draftPullRequest: null
  })

  assert.match(body, /^## Security Review$/m)
  assert.match(body, /- Analysis: `confirmed security defect`/)
  assert.match(body, /- Mitigation: `patch proposed, 1 file changed`/)
  assert.match(
    body,
    /- Verification: `full coverage; logic simulation; checks not run`/
  )
  assert.match(body, /- Patch ready: `yes`/)
  assert.match(body, /- `src\/app\.ts`/)
  assert.doesNotMatch(body, /Next step/)
})
