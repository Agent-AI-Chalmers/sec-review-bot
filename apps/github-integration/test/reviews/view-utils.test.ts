import assert from 'node:assert/strict'
import test from 'node:test'

import {
  inlineCode,
  renderAnalysisNarratives,
  renderChangedFilesLines,
  renderVerificationSummaryLines
} from '../../src/reviews/view-utils.js'

test('view utils render missing inline code values with explicit fallback', () => {
  assert.strictEqual(inlineCode(null), '`unknown`')
  assert.strictEqual(inlineCode(undefined, 'n/a'), '`n/a`')
})

test('view utils use a longer code span fence around embedded backticks', () => {
  assert.strictEqual(inlineCode('user`name'), '``user`name``')
  assert.strictEqual(inlineCode('user``name'), '```user``name```')
  assert.strictEqual(inlineCode('`quoted`'), '`` `quoted` ``')
})

test('view utils render changed files with a safe inline code fence', () => {
  assert.deepStrictEqual(renderChangedFilesLines(['src/uses`tick.ts']), [
    'Changed files:',
    '',
    '- ``src/uses`tick.ts``'
  ])
})

test('view utils render verification summary with stable order and finding summaries', () => {
  assert.deepStrictEqual(
    renderVerificationSummaryLines(
      {
        coverage: 'full',
        regression: 'not-run',
        next_step: 'none',
        validation_level: 'static',
        target_claim: 'The patch covers retry payloads.',
        findings: [{ summary: 'Patch updates retry validation.' }],
        evidence: ['No regression suite was run.'],
        residual_risks: []
      },
      {
        includeOverview: false,
        includeUnknownNextStep: true
      }
    ),
    [
      '- Coverage: `full`',
      '- Regression: `not-run`',
      '- Next step: `none`',
      '- Validation level: `static`',
      '',
      'Target claim:',
      '',
      'The patch covers retry payloads.',
      '',
      'Findings:',
      '- Patch updates retry validation.',
      '',
      'Evidence:',
      '- No regression suite was run.'
    ]
  )
})

test('view utils preserve inline code in review prose', () => {
  assert.deepStrictEqual(
    renderVerificationSummaryLines(
      {
        coverage: 'full',
        regression: 'passed',
        next_step: 'none',
        validation_level: 'static',
        target_claim:
          'The patch updates `agents/src/sec_review_agents/resources/prompts/memory/extract-system.md`.',
        findings: [],
        evidence: ['`MemoryObservationOutput` remains unchanged.'],
        residual_risks: []
      },
      {
        includeOverview: false
      }
    ),
    [
      '- Coverage: `full`',
      '- Regression: `passed`',
      '- Next step: `none`',
      '- Validation level: `static`',
      '',
      'Target claim:',
      '',
      'The patch updates `agents/src/sec_review_agents/resources/prompts/memory/extract-system.md`.',
      '',
      'Evidence:',
      '- `MemoryObservationOutput` remains unchanged.'
    ]
  )
})

test('view utils keep narrative scope decisions visible', () => {
  // The narrative body is an explicit allow-list of fields, so scope data silently
  // disappears from the review bodies unless the layout follows the model.
  const lines = renderAnalysisNarratives([
    {
      title: 'Path traversal in the export endpoint',
      verdict: 'confirmed-vulnerability',
      vulnerability_type: 'path-traversal',
      validation_level: 'logic-simulated',
      description: 'The export route joins request input onto the export root.',
      scope_review: {
        scope_shape: 'local-defect',
        outcome_deciding_control_point: 'path.join(EXPORT_ROOT, file)',
        scope_analysis: 'Only this route builds an export path.'
      },
      related_paths: [
        {
          label: 'src/server.ts route mounting',
          relationship: 'different-semantics'
        }
      ]
    }
  ])
  const rendered = lines.join('\n')

  assert.ok(rendered.includes('path.join(EXPORT_ROOT, file)'))
  assert.ok(rendered.includes('Only this route builds an export path.'))
  assert.ok(rendered.includes('src/server.ts route mounting'))
})
