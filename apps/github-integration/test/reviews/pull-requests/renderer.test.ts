import assert from 'node:assert/strict'
import test from 'node:test'

import { renderAnalysisSummaryCommentFromReviewRecord } from '../../../src/reviews/pull-requests/renderer.js'

test('pull request renderer preserves inline code in review prose', () => {
  const body = renderAnalysisSummaryCommentFromReviewRecord({
    analysis: {
      verdict: 'no-actionable-finding',
      overview:
        'The PR updates `agents/src/sec_review_agents/resources/prompts/memory/extract-system.md`.',
      narratives: [
        {
          priority: 1,
          title: 'Prompt refinement',
          verdict: 'no-actionable-finding',
          description: '`MemoryObservationOutput` remains unchanged.',
          locations: []
        }
      ]
    },
    mitigation: {
      overview: null,
      file_changes: [],
      patch_diff: null
    },
    verification: {
      overview: null,
      target_claim: 'The loader still calls `load_prompt_resource`.',
      validation_level: 'static',
      coverage: 'full',
      regression: 'not-run',
      next_step: 'none',
      findings: [],
      evidence: [
        '`agents/tests/memory/test_memory.py` covers the prompt contract.'
      ],
      residual_risks: []
    },
    cvss: null
  })

  assert.match(
    body,
    /`agents\/src\/sec_review_agents\/resources\/prompts\/memory\/extract-system\.md`/
  )
  assert.match(body, /`MemoryObservationOutput` remains unchanged\./)
  assert.match(body, /`load_prompt_resource`/)
  assert.match(body, /`agents\/tests\/memory\/test_memory\.py`/)
  assert.doesNotMatch(body, /\\`agents\/src/)
})

test('pull request renderer summarizes each review stage without implying PR file count or test coverage', () => {
  const body = renderAnalysisSummaryCommentFromReviewRecord({
    analysis: {
      verdict: 'no-actionable-finding',
      overview: 'No actionable issue was confirmed.',
      narratives: []
    },
    mitigation: {
      overview: 'No mitigation was needed.',
      file_changes: [],
      patch_diff: null
    },
    verification: {
      overview: 'The result was reviewed statically.',
      target_claim: null,
      validation_level: 'static',
      coverage: 'full',
      regression: 'not-run',
      next_step: 'none',
      findings: [],
      evidence: [],
      residual_risks: []
    },
    cvss: null
  })

  assert.match(body, /- Analysis: `no actionable security finding`/)
  assert.match(body, /- Mitigation: `not needed`/)
  assert.match(
    body,
    /- Verification: `full coverage; static review; checks not run`/
  )
  assert.doesNotMatch(body, /- Tests:/)
  assert.doesNotMatch(body, /Changed files: `0`/)
  assert.doesNotMatch(body, /Next step: `none`/)
})

test('pull request renderer reports mitigation file count only when a patch exists', () => {
  const body = renderAnalysisSummaryCommentFromReviewRecord({
    analysis: {
      verdict: 'confirmed-vulnerability',
      overview: 'A vulnerability was confirmed.',
      narratives: []
    },
    mitigation: {
      overview: 'A patch was proposed.',
      file_changes: [
        { path: 'src/a.ts', status: 'deleted' },
        { path: 'src/b.ts', status: 'deleted' }
      ],
      patch_diff: 'patch'
    },
    verification: {
      overview: null,
      target_claim: null,
      validation_level: 'runtime-partial',
      coverage: 'partial',
      regression: 'failed',
      next_step: 'manual-review',
      findings: [],
      evidence: [],
      residual_risks: []
    },
    cvss: null
  })

  assert.match(body, /- Analysis: `confirmed security vulnerability`/)
  assert.match(body, /- Mitigation: `patch proposed, 2 files changed`/)
  assert.match(
    body,
    /- Verification: `partial coverage; partial runtime validation; checks failed`/
  )
  assert.doesNotMatch(body, /- Tests:/)
  assert.match(body, /- Next step: `manual-review`/)
})
