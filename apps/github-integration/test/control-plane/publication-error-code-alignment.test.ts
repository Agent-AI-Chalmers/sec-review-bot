// Control Plane's terminal publication-step codes must stay terminal here.
//
// `classifyPublicationFailure` decides retry vs. terminal from the string `code` that crosses
// the REST boundary (a 409 with `code`). If Control Plane emits a new deterministic code this
// package does not recognize, it falls through to `retry: true` and the runner retries the
// same stored run forever. Read the codes from Control Plane's single source so the two
// packages stay aligned.
import assert from 'node:assert/strict'
import test from 'node:test'

import { PUBLICATION_STEP_ERROR_CODES } from '../../../../control-plane/src/errors.js'
import { classifyPublicationFailure } from '../../src/control-plane/publication-failure.js'
import { RUNNER_PUBLISH_ERROR_CODES } from '../../src/runner/publish-error-code.js'

test('every Control Plane publication-step code is known and terminal', () => {
  const codes = Object.values(PUBLICATION_STEP_ERROR_CODES)
  assert.ok(codes.length > 0, 'expected publication-step codes')

  const known = new Set<string>(Object.values(RUNNER_PUBLISH_ERROR_CODES))
  for (const code of codes) {
    assert.ok(known.has(code), `${code} is missing from RUNNER_PUBLISH_ERROR_CODES`)
    // A Control Plane deterministic error carries only a `code`; it has no HTTP status, so
    // a missing classification here would resolve to `retry: true`.
    assert.equal(
      classifyPublicationFailure({ code }).retry,
      false,
      `${code} must be classified as terminal (retry: false)`
    )
  }
})
