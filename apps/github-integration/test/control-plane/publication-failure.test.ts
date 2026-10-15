import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyPublicationFailure } from '../../src/control-plane/publication-failure.js'
import { RUNNER_PUBLISH_ERROR_CODES } from '../../src/runner/publish-error-code.js'

test('a publication step that exhausted its retry budget fails rather than retries', () => {
  // Control Plane throws PUBLICATION_STEP_RETRY_EXHAUSTED once a step is
  // terminal_failed. The integration receives a plain error carrying only that
  // code. Classifying it as retryable would re-claim the same terminal_failed
  // step and fail the same way forever, so it must be terminal.
  const error = Object.assign(
    new Error('Publication step exhausted its retry budget: issue:draft-pr'),
    { code: RUNNER_PUBLISH_ERROR_CODES.publication_step_retry_exhausted }
  )
  assert.deepStrictEqual(classifyPublicationFailure(error), {
    retry: false,
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
