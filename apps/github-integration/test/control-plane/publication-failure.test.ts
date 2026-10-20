import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyPublicationFailure } from '../../src/control-plane/publication-failure.js'
import { RUNNER_PUBLISH_ERROR_CODES } from '../../src/runner/publish-error-code.js'

test('a publication step that exhausted its retry budget fails rather than retries', () => {
  // Control Plane throws PUBLICATION_STEP_RETRY_EXHAUSTED once a step has no attempt left, and
  // answers the refusal with a 409. Classifying it as retryable would re-claim the same step and
  // fail the same way forever, so a refusal must be terminal.
  const error = Object.assign(
    new Error('Publication step exhausted its retry budget: issue:draft-pr'),
    {
      code: RUNNER_PUBLISH_ERROR_CODES.publication_step_retry_exhausted,
      status: 409
    }
  )
  assert.deepStrictEqual(classifyPublicationFailure(error), {
    retry: false,
    code: 'PUBLICATION_STEP_RETRY_EXHAUSTED',
    reason: 'publication-step-retry-exhausted'
  })
})

test('the same exhaustion code carried by a proxy answer stays retryable', () => {
  // The publish paths rethrow whatever the claim call threw. A proxy or load balancer answering
  // 502/503 in front of Control Plane can relay the same code without Control Plane having
  // decided anything about the step, so treating a 5xx as a verdict would end a publication whose
  // steps were never refused. (A client-side timeout does not carry this code at all: the client
  // raises `CONTROL_PLANE_REQUEST_TIMEOUT` for those, which is already retryable.)
  const relayed = Object.assign(new Error('Bad Gateway'), {
    code: RUNNER_PUBLISH_ERROR_CODES.publication_step_retry_exhausted,
    status: 503
  })
  assert.deepStrictEqual(classifyPublicationFailure(relayed), {
    retry: true,
    code: 'PUBLICATION_STEP_RETRY_EXHAUSTED',
    reason: 'publication-step-retry-exhausted'
  })
})

test('Control Plane publication faults that cannot be repaired fail rather than retry', () => {
  // The step set of a stored run is fixed once publication starts, so a
  // duplicate or changed step set is re-derived identically on every claim.
  // A generic Error without a code stays retryable, which is why these need
  // their own codes: an uncoded deterministic fault looped forever.
  for (const [code, reason] of [
    [
      RUNNER_PUBLISH_ERROR_CODES.publication_step_set_duplicate,
      'control-plane-deterministic-publication-fault'
    ],
    [
      RUNNER_PUBLISH_ERROR_CODES.publication_step_set_changed,
      'control-plane-deterministic-publication-fault'
    ]
  ] as const) {
    const error = Object.assign(
      new Error('Publication step set is not usable.'),
      { code }
    )
    assert.deepStrictEqual(classifyPublicationFailure(error), {
      retry: false,
      code,
      reason
    })
  }

  assert.deepStrictEqual(
    classifyPublicationFailure(new Error('Publication step set changed.')),
    {
      retry: true,
      code: null,
      reason: 'unknown-publish-error'
    }
  )
})
