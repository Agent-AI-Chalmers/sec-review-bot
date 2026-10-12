// Control Plane's terminal publication-step codes must stay terminal here.
//
// The codes live in the generated Control Plane OpenAPI document (the contract), and
// `classifyPublicationFailure` decides retry vs. terminal. If Control Plane emits a new
// deterministic code this package does not recognize, the error has no HTTP status, so it
// falls through to `retry: true` and the runner retries the same stored run forever. Read
// the codes from the contract document itself rather than Control Plane's source, so the
// two packages stay aligned through the artifact they already share.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { classifyPublicationFailure } from '../../src/control-plane/publication-failure.js'
import { RUNNER_PUBLISH_ERROR_CODES } from '../../src/runner/publish-error-code.js'

const DOC_PATH = new URL('../../../../contracts/control-plane-api/openapi.json', import.meta.url)

function publicationStepCodes(): string[] {
  const document = JSON.parse(readFileSync(DOC_PATH, 'utf8')) as {
    components: { schemas: { ErrorResponse: { properties: { code: { enum: string[] } } } } }
  }
  return document.components.schemas.ErrorResponse.properties.code.enum.filter((code) =>
    code.startsWith('PUBLICATION_STEP_')
  )
}

test('every Control Plane publication-step code is known and terminal', () => {
  const codes = publicationStepCodes()
  assert.ok(codes.length > 0, 'expected publication-step codes in the OpenAPI document')

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
