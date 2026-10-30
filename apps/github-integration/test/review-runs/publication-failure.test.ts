import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyPublicationFailure } from '../../src/review-runs/publication-failure.js'
import { EXECUTION_PUBLISH_ERROR_CODES } from '../../src/execution/publish-error-code.js'

test('a publication step that exhausted its retry budget fails rather than retries', () => {
  // Review Runs throws PUBLICATION_STEP_RETRY_EXHAUSTED once a step has no attempt left, and
  // answers the refusal with a 409. Classifying it as retryable would re-claim the same step and
  // fail the same way forever, so a refusal must be terminal.
  const error = Object.assign(
    new Error('Publication step exhausted its retry budget: issue:draft-pr'),
    {
      code: EXECUTION_PUBLISH_ERROR_CODES.publication_step_retry_exhausted,
      status: 409
    }
  )
  assert.deepStrictEqual(classifyPublicationFailure(error), {
    retry: false,
    scope: 'step',
    code: 'PUBLICATION_STEP_RETRY_EXHAUSTED',
    reason: 'publication-step-retry-exhausted'
  })
})

test('the same exhaustion code carried by a proxy answer stays retryable', () => {
  // The publish paths rethrow whatever the claim call threw. A proxy or load balancer answering
  // 502/503 in front of Review Runs can relay the same code without Review Runs having
  // decided anything about the step, so treating a 5xx as a verdict would end a publication whose
  // steps were never refused. (A client-side timeout does not carry this code at all: the client
  // raises `REVIEW_RUNS_REQUEST_TIMEOUT` for those, which is already retryable.)
  const relayed = Object.assign(new Error('Bad Gateway'), {
    code: EXECUTION_PUBLISH_ERROR_CODES.publication_step_retry_exhausted,
    status: 503
  })
  assert.deepStrictEqual(classifyPublicationFailure(relayed), {
    retry: true,
    scope: 'publication',
    code: 'PUBLICATION_STEP_RETRY_EXHAUSTED',
    reason: 'publication-step-retry-exhausted'
  })
})

test('a refused credential ends the publication instead of the next delivery', () => {
  // The batch records each delivery's failure and carries on. That is right for a 404 or a 422,
  // which belong to one delivery, but wrong for a rejected credential: every remaining delivery
  // would fail the same way. Scope is what lets the batch tell the two apart.
  const refused = Object.assign(new Error('Bad credentials'), { status: 401 })
  assert.deepStrictEqual(classifyPublicationFailure(refused), {
    retry: false,
    scope: 'publication',
    code: 'GITHUB_AUTH_REJECTED',
    reason: 'github-auth-rejected'
  })
})

test('a delivery-scoped refusal keeps the rest of the publication running', () => {
  const missing = Object.assign(new Error('Not Found'), { status: 404 })
  assert.strictEqual(classifyPublicationFailure(missing).scope, 'step')
  assert.strictEqual(classifyPublicationFailure(missing).retry, false)
})

test('Review Runs publication faults that cannot be repaired fail rather than retry', () => {
  // The step set of a stored run is fixed once publication starts, so a
  // duplicate or changed step set is re-derived identically on every claim.
  // A generic Error without a code stays retryable, which is why these need
  // their own codes: an uncoded deterministic fault looped forever.
  for (const [code, reason] of [
    [
      EXECUTION_PUBLISH_ERROR_CODES.publication_step_set_duplicate,
      'review-runs-deterministic-publication-fault'
    ],
    [
      EXECUTION_PUBLISH_ERROR_CODES.publication_step_set_changed,
      'review-runs-deterministic-publication-fault'
    ]
  ] as const) {
    const error = Object.assign(
      new Error('Publication step set is not usable.'),
      { code }
    )
    assert.deepStrictEqual(classifyPublicationFailure(error), {
      retry: false,
      scope: 'step',
      code,
      reason
    })
  }

  assert.deepStrictEqual(
    classifyPublicationFailure(new Error('Publication step set changed.')),
    {
      retry: true,
      scope: 'publication',
      code: null,
      reason: 'unknown-publish-error'
    }
  )
})
