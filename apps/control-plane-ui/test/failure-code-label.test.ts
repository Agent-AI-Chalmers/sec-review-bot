// Failure codes are an open set: coordination writes a fixed handful, connectors add their own.
// The console explains the ones it knows and shows the rest verbatim. Getting this wrong is not
// cosmetic - an operator reading an unexplained code has to guess whether the run can be retried
// or is terminal.
import { expect, test } from 'vitest'

import {
  abandonFailureMessageKey,
  failureCodeLabel,
  KNOWN_FAILURE_CODE_KEYS
} from '../browser/features/runs/format.js'
import { ApiError } from '../browser/shared/api-client.js'
import { messages, translate, type Translator } from '../browser/shared/i18n.js'

const t: Translator = (key, ...args) => translate('en', key, ...args)

test('every code the console explains has a sentence in both languages', () => {
  // Enumerate the mapping itself rather than a hand-picked subset: a code added to the console
  // must arrive with both translations, or it renders as an unexplained code (or, before the
  // null guard, an empty tooltip). Looking the key up by its text was also fragile - two codes
  // sharing a sentence would have made this assert against the wrong key.
  for (const [code, messageKey] of Object.entries(KNOWN_FAILURE_CODE_KEYS)) {
    const result = failureCodeLabel(code, t)
    expect(result.code, 'the code itself is always returned').toBe(code)
    expect.assert(
      result.explanation !== null && result.explanation.length > 0,
      `${code} must have an explanation`
    )
    for (const language of ['en', 'zh'] as const) {
      const value = (messages[language] as Record<string, string>)[messageKey]
      expect.assert(
        typeof value === 'string' && value.length > 0,
        `${code} has no ${language} translation for ${messageKey}`
      )
    }
  }
})

test('a connector-supplied failure code is shown without an invented explanation', () => {
  const result = failureCodeLabel('SOMETHING_THE_CONNECTOR_INVENTED', t)
  expect(result.code).toBe('SOMETHING_THE_CONNECTOR_INVENTED')
  expect(result.explanation).toBe(null)
})

test('a code whose sentence is missing from the active language renders no tooltip', () => {
  // `t()` returns undefined for a key that is not in the table. Only testing the mapping's
  // presence returned that undefined as the explanation, and the caller checks for null, so it
  // rendered an empty tooltip instead of falling back to the bare code.
  const missingTable = (() => undefined) as unknown as Translator
  const result = failureCodeLabel('PREPARATION_RETRY_EXHAUSTED', missingTable)
  expect(result.code).toBe('PREPARATION_RETRY_EXHAUSTED')
  expect(result.explanation).toBe(null)
})

// A 401 can reject the operator token, the UI session, or the upstream request.
// Keep each cause visible as a separate case even when the displayed result is shared.
test.each([
  {
    name: 'invalid operator token',
    error: new ApiError(401, 'admin_token_required'),
    expected: 'abandonWrongToken'
  },
  {
    name: 'expired UI session',
    error: new ApiError(401, 'unauthorized'),
    expected: 'sessionExpired'
  },
  {
    name: 'upstream 401 without a BFF code',
    error: new ApiError(401),
    expected: 'abandonFailed'
  },
  {
    name: 'upstream 401 with an availability code',
    error: new ApiError(401, 'review_runs_unavailable'),
    expected: 'abandonFailed'
  },
  {
    name: 'unavailable upstream',
    error: new ApiError(502, 'review_runs_unavailable'),
    expected: 'abandonFailed'
  },
  {
    name: 'network failure',
    error: new Error('network down'),
    expected: 'abandonFailed'
  }
])('abandon failure: $name', ({ error, expected }) => {
  expect(abandonFailureMessageKey(error)).toBe(expected)
})

test('every abandon failure message has a translation in both languages', () => {
  for (const key of ['abandonWrongToken', 'abandonFailed', 'sessionExpired'] as const) {
    for (const language of ['en', 'zh'] as const) {
      const value = (messages[language] as Record<string, string>)[key]
      expect.assert(
        typeof value === 'string' && value.length > 0,
        `${key} is missing from ${language}`
      )
    }
  }
})
