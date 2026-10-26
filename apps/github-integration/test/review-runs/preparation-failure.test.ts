// Retry classification must keep deterministic setup failures from becoming an
// infinite background loop while allowing temporary GitHub failures to recover.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyPreparationFailure,
  InvalidPreparationInputError
} from '../../src/review-runs/preparation-failure.js'

test('preparation retries a transient GitHub response with bounded backoff', () => {
  const error = Object.assign(new Error('GitHub unavailable'), {
    response: { status: 503, headers: {}, data: {} }
  })
  assert.deepStrictEqual(classifyPreparationFailure(error, 3), {
    retry: true,
    code: null,
    retryAfterMs: 20_000
  })
})

test('preparation does not retry a deterministic setup failure', () => {
  assert.deepStrictEqual(
    classifyPreparationFailure(new Error('invalid setup declaration'), 1, true),
    { retry: false, code: null }
  )
})

test('preparation does not retry malformed durable connector input', () => {
  assert.deepStrictEqual(
    classifyPreparationFailure(
      new InvalidPreparationInputError(
        'Unsupported preparation input version.'
      ),
      4
    ),
    { retry: false, code: null }
  )
})
