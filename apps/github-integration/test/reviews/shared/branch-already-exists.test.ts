import assert from 'node:assert/strict'
import test from 'node:test'

import { isBranchAlreadyExists } from '../../../src/reviews/shared/branch-already-exists.js'

function githubError(status: number, data?: { message?: string }): Error {
  return Object.assign(new Error('Request failed'), {
    status,
    response: { status, data }
  })
}

test('isBranchAlreadyExists only trusts the GitHub response message', () => {
  // `createRef` uses 422 for both "reference already exists" and an invalid ref name, so the
  // message decides. Only the response payload is a GitHub statement; the top-level error
  // message can come from a proxy or a wrapped error, so it must not be able to turn an
  // unrelated 422 into "the branch is already there, verify and reuse it".
  assert.strictEqual(
    isBranchAlreadyExists(
      githubError(422, { message: 'Reference already exists' })
    ),
    true
  )

  // The regression this guards: a 422 with no response payload but a top-level message that
  // happens to contain the phrase. It must fail closed, not be treated as a recovery checkpoint.
  const noPayload = Object.assign(
    new Error('upstream said: reference already exists somewhere'),
    { status: 422, response: { status: 422, data: undefined } }
  )
  assert.strictEqual(isBranchAlreadyExists(noPayload), false)

  // The other 422 reason must never be read as a recovery checkpoint.
  assert.strictEqual(
    isBranchAlreadyExists(githubError(422, { message: 'Invalid ref name' })),
    false
  )

  // A different status is never a branch-exists signal, even with a matching message.
  assert.strictEqual(
    isBranchAlreadyExists(
      githubError(500, { message: 'Reference already exists' })
    ),
    false
  )

  // A bare error carries no GitHub payload at all.
  assert.strictEqual(isBranchAlreadyExists(new Error('already exists')), false)
})
