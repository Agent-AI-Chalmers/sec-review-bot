// Failure codes are an open set: coordination writes a fixed handful, connectors add their own.
// The console explains the ones it knows and shows the rest verbatim. Getting this wrong is not
// cosmetic - an operator reading an unexplained code has to guess whether the run can be retried
// or is terminal.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  abandonFailureMessageKey,
  failureCodeLabel,
  KNOWN_FAILURE_CODE_KEYS
} from '../src/format.js'
import { ApiError } from '../src/api.js'
import { messages, type Message } from '../src/i18n.js'

const t = (key: keyof typeof messages.en): string => messages.en[key]

test('every code the console explains has a sentence in both languages', () => {
  // Enumerate the mapping itself rather than a hand-picked subset: a code added to the console
  // must arrive with both translations, or it renders as an unexplained code (or, before the
  // null guard, an empty tooltip). Looking the key up by its text was also fragile - two codes
  // sharing a sentence would have made this assert against the wrong key.
  for (const [code, messageKey] of Object.entries(KNOWN_FAILURE_CODE_KEYS)) {
    const result = failureCodeLabel(code, t)
    assert.strictEqual(result.code, code, 'the code itself is always returned')
    assert.ok(
      result.explanation !== null && result.explanation.length > 0,
      `${code} must have an explanation`
    )
    for (const language of ['en', 'zh'] as const) {
      const value = (messages[language] as Record<string, string>)[messageKey]
      assert.ok(
        typeof value === 'string' && value.length > 0,
        `${code} has no ${language} translation for ${messageKey}`
      )
    }
  }
})

test('a connector-supplied failure code is shown without an invented explanation', () => {
  const result = failureCodeLabel('SOMETHING_THE_CONNECTOR_INVENTED', t)
  assert.strictEqual(result.code, 'SOMETHING_THE_CONNECTOR_INVENTED')
  assert.strictEqual(result.explanation, null)
})

test('a code whose sentence is missing from the active language renders no tooltip', () => {
  // `t()` returns undefined for a key that is not in the table. Only testing the mapping's
  // presence returned that undefined as the explanation, and the caller checks for null, so it
  // rendered an empty tooltip instead of falling back to the bare code.
  const missingTable = (() => undefined) as unknown as (key: Message) => string
  const result = failureCodeLabel('PREPARATION_RETRY_EXHAUSTED', missingTable)
  assert.strictEqual(result.code, 'PREPARATION_RETRY_EXHAUSTED')
  assert.strictEqual(result.explanation, null)
})

test('an abandon failure names the credential that was actually rejected', () => {
  // The abandon route answers 401 for three unrelated causes; only the first is a bad token.
  // Reporting the others that way tells the operator to re-type a token that was correct.
  const cases: Array<[unknown, string]> = [
    [new ApiError(401, 'admin_token_required'), 'abandonWrongToken'],
    [new ApiError(401, 'unauthorized'), 'sessionExpired'],
    // The Control Plane's own 401, proxied through the BFF without a BFF error code.
    [new ApiError(401), 'abandonFailed'],
    [new ApiError(401, 'control_plane_unavailable'), 'abandonFailed'],
    [new ApiError(502, 'control_plane_unavailable'), 'abandonFailed'],
    [new Error('network down'), 'abandonFailed']
  ]
  for (const [error, expected] of cases) {
    assert.strictEqual(abandonFailureMessageKey(error), expected)
  }
})

test('every abandon failure message has a translation in both languages', () => {
  for (const key of [
    'abandonWrongToken',
    'abandonFailed',
    'sessionExpired'
  ] as const) {
    for (const language of ['en', 'zh'] as const) {
      const value = (messages[language] as Record<string, string>)[key]
      assert.ok(
        typeof value === 'string' && value.length > 0,
        `${key} is missing from ${language}`
      )
    }
  }
})
