import { expect, test } from 'vitest'

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
      target_claim: 'reviewed claim',
      validation_level: 'logic-simulated',
      coverage: 'full',
      regression: 'not-run',
      next_step: 'none',
      findings: [],
      evidence: [],
      residual_risks: []
    },
    cvss: null
  }
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

  expect(body).toMatch(/^## Issue Security Review$/m)
  expect(body).toMatch(/- Analysis: `confirmed security defect`/)
  expect(body).toMatch(/- Mitigation: `patch proposed, 1 file changed`/)
  expect(body).toMatch(/- Verification: `full coverage; logic simulation; checks not run`/)
  expect(body).toMatch(/Analyzer overview text\./)
  expect(body).toMatch(/PR: #97 \(https:\/\/example\.test\/pull\/97\)/)
  expect(body).not.toMatch(/\*\*Verification:\*\*/)
})

test('unpromoted issue comment shares the same status vocabulary and reports the plan', () => {
  const body = renderIssueReviewCommentFromReviewRecord({
    issue: { issue_number: 42 },
    review_record: reviewRecord(),
    draftPrPlan: { patch_ready: true },
    draftPullRequest: null
  })

  expect(body).toMatch(/^## Security Review$/m)
  expect(body).toMatch(/- Analysis: `confirmed security defect`/)
  expect(body).toMatch(/- Mitigation: `patch proposed, 1 file changed`/)
  expect(body).toMatch(/- Verification: `full coverage; logic simulation; checks not run`/)
  expect(body).toMatch(/- Patch ready: `yes`/)
  expect(body).toMatch(/- `src\/app\.ts`/)
  expect(body).toMatch(/Next step: `none`/)
})
