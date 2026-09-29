import assert from 'node:assert/strict'
import test from 'node:test'

import { renderAnalysisSummaryCommentFromReviewRecord } from '../../../reviews/pull-requests/renderer.js'

test('pull request renderer preserves inline code in review prose', () => {
  const body = renderAnalysisSummaryCommentFromReviewRecord({
    analysis: {
      verdict: 'no-actionable-finding',
      overview: 'The PR updates `agents/src/sec_review_agents/resources/prompts/memory/extract-system.md`.',
      narratives: [{
        priority: 1,
        title: 'Prompt refinement',
        verdict: 'no-actionable-finding',
        description: '`MemoryObservationOutput` remains unchanged.',
        locations: []
      }]
    },
    mitigation: {
      overview: null,
      changed_files: [],
      file_changes: [],
      patch_diff: null
    },
    verification: {
      overview: null,
      review_target_claim: 'The loader still calls `load_prompt_resource`.',
      validation_level: 'static',
      patch_coverage: 'not-applicable',
      regression_status: 'not-run',
      resolution_next_step: 'none',
      patch_findings: [],
      verification_findings: [
        '`agents/tests/memory/test_memory.py` covers the prompt contract.'
      ],
      residual_risks: []
    },
    cvss: null
  })

  assert.match(body, /`agents\/src\/sec_review_agents\/resources\/prompts\/memory\/extract-system\.md`/)
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
      changed_files: [],
      file_changes: [],
      patch_diff: null
    },
    verification: {
      overview: 'The result was reviewed statically.',
      review_target_claim: null,
      validation_level: 'static',
      patch_coverage: 'full',
      regression_status: 'not-run',
      resolution_next_step: 'none',
      patch_findings: [],
      verification_findings: [],
      residual_risks: []
    },
    cvss: null
  })

  assert.match(body, /- Analysis: `no actionable security finding`/)
  assert.match(body, /- Mitigation: `not needed`/)
  assert.match(body, /- Verification: `static review; checks not run`/)
  assert.doesNotMatch(body, /- Tests:/)
  assert.doesNotMatch(body, /Changed files: `0`/)
  assert.doesNotMatch(body, /Resolution next step: `none`/)
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
      changed_files: ['src/a.ts', 'src/b.ts'],
      file_changes: [],
      patch_diff: 'patch'
    },
    verification: {
      overview: null,
      review_target_claim: null,
      validation_level: 'runtime-partial',
      patch_coverage: 'partial',
      regression_status: 'failed',
      resolution_next_step: 'manual-review',
      patch_findings: [],
      verification_findings: [],
      residual_risks: []
    },
    cvss: null
  })

  assert.match(body, /- Analysis: `confirmed security vulnerability`/)
  assert.match(body, /- Mitigation: `patch proposed, 2 files changed`/)
  assert.match(body, /- Verification: `partial runtime validation; checks failed`/)
  assert.doesNotMatch(body, /- Tests:/)
  assert.match(body, /- Resolution next step: `manual-review`/)
})
