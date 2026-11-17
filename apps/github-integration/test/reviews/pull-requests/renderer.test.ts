import { expect, test } from 'vitest'

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

  expect(body).toMatch(
    /`agents\/src\/sec_review_agents\/resources\/prompts\/memory\/extract-system\.md`/
  )
  expect(body).toMatch(/`MemoryObservationOutput` remains unchanged\./)
  expect(body).toMatch(/`load_prompt_resource`/)
  expect(body).toMatch(/`agents\/tests\/memory\/test_memory\.py`/)
  expect(body).not.toMatch(/\\`agents\/src/)
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

  expect(body).toMatch(/- Analysis: `no actionable security finding`/)
  expect(body).toMatch(/- Mitigation: `not needed`/)
  expect(body).toMatch(
    /- Verification: `full coverage; static review; checks not run`/
  )
  expect(body).not.toMatch(/- Tests:/)
  expect(body).not.toMatch(/Changed files: `0`/)
  expect(body).not.toMatch(/Next step: `none`/)
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

  expect(body).toMatch(/- Analysis: `confirmed security vulnerability`/)
  expect(body).toMatch(/- Mitigation: `patch proposed, 2 files changed`/)
  expect(body).toMatch(
    /- Verification: `partial coverage; partial runtime validation; checks failed`/
  )
  expect(body).not.toMatch(/- Tests:/)
  expect(body).toMatch(/- Next step: `manual-review`/)
})
