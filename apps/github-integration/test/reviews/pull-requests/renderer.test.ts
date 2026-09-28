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
