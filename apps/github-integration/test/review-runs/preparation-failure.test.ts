// Retry classification must keep deterministic setup failures from becoming an
// infinite background loop while allowing temporary GitHub failures to recover.
import { expect, test } from 'vitest'

import {
  classifyPreparationFailure,
  InvalidPreparationInputError
} from '../../src/review-runs/preparation-failure.js'

test('preparation retries a transient GitHub response with bounded backoff', () => {
  const error = Object.assign(new Error('GitHub unavailable'), {
    response: { status: 503, headers: {}, data: {} }
  })
  expect(classifyPreparationFailure(error, 3)).toStrictEqual({
    retry: true,
    code: null,
    retryAfterMs: 20_000
  })
})

test('preparation does not retry a deterministic setup failure', () => {
  expect(classifyPreparationFailure(new Error('invalid setup declaration'), 1, true)).toStrictEqual(
    { retry: false, code: null }
  )
})

test('preparation does not retry malformed durable connector input', () => {
  expect(
    classifyPreparationFailure(
      new InvalidPreparationInputError('Unsupported preparation input version.'),
      4
    )
  ).toStrictEqual({ retry: false, code: null })
})
