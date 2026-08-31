import assert from 'node:assert/strict'
import test from 'node:test'

import {
  inlineCode,
  renderChangedFilesLines,
  renderVerificationSummaryLines
} from '../../reviews/view-utils.js'

test('view utils render missing inline code values with explicit fallback', () => {
  assert.equal(inlineCode(null), '`unknown`')
  assert.equal(inlineCode(undefined, 'n/a'), '`n/a`')
})

test('view utils render changed files with escaped inline code', () => {
  assert.deepEqual(renderChangedFilesLines(['src/uses`tick.ts']), [
    'Changed files:',
    '',
    '- `src/uses\\`tick.ts`'
  ])
})

test('view utils render verification summary with stable order and finding summaries', () => {
  assert.deepEqual(
    renderVerificationSummaryLines({
      patch_coverage: 'full',
      regression_status: 'not-run',
      resolution_next_step: 'none',
      validation_level: 'static',
      review_target_claim: 'The patch covers retry payloads.',
      patch_findings: [{ summary: 'Patch updates retry validation.' }],
      verification_findings: ['No regression suite was run.'],
      residual_risks: []
    }, {
      includeOverview: false,
      includeUnknownResolutionNextStep: true
    }),
    [
      '- Patch coverage: `full`',
      '- Regression status: `not-run`',
      '- Resolution next step: `none`',
      '- Validation level: `static`',
      '',
      'Review target claim:',
      '',
      'The patch covers retry payloads.',
      '',
      'Patch findings:',
      '- Patch updates retry validation.',
      '',
      'Verification findings:',
      '- No regression suite was run.'
    ]
  )
})
