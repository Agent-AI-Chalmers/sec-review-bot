// Failure codes are an open set: coordination writes a fixed handful, connectors add their own.
// The console explains the ones it knows and shows the rest verbatim. Getting this wrong is not
// cosmetic - an operator reading an unexplained code has to guess whether the run can be retried
// or is terminal.
import assert from 'node:assert/strict'
import test from 'node:test'

import { failureCodeLabel } from '../src/format.js'
import { messages } from '../src/i18n.js'

const t = (key: keyof typeof messages.en): string => messages.en[key]

test('a known failure code is explained in both languages', () => {
  for (const code of [
    'PREPARATION_RETRY_EXHAUSTED',
    'PREPARATION_ABANDONED',
    'EXECUTION_ALREADY_ADVANCED',
    'SUBMISSION_STATE_UNCERTAIN',
    'PUBLICATION_ABANDONED',
    'GITHUB_VALIDATION_REJECTED'
  ]) {
    const result = failureCodeLabel(code, t)
    assert.strictEqual(result.code, code, 'the code itself is always returned')
    assert.ok(
      result.explanation !== null && result.explanation.length > 0,
      `${code} must have an explanation`
    )
    for (const language of ['en', 'zh'] as const) {
      const key = Object.entries(messages.en).find(
        ([, value]) => value === result.explanation
      )?.[0]
      assert.ok(key !== undefined, `${code} explanation has no key`)
      assert.ok(
        key in messages[language],
        `${code} has no ${language} translation for ${key}`
      )
    }
  }
})

test('a connector-supplied failure code is shown without an invented explanation', () => {
  const result = failureCodeLabel('SOMETHING_THE_CONNECTOR_INVENTED', t)
  assert.strictEqual(result.code, 'SOMETHING_THE_CONNECTOR_INVENTED')
  assert.strictEqual(result.explanation, null)
})
