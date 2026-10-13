// Control Plane's terminal publication-step codes must stay terminal here.
//
// `classifyPublicationFailure` decides retry vs. terminal from the string `code` that crosses
// the REST boundary (a 409 with `code`). If Control Plane emits a new deterministic code this
// package does not recognize, it falls through to `retry: true` and the runner retries the
// same stored run forever. Read the codes from Control Plane's contract — the shared,
// single source both packages derive from — rather than from its source tree, so this test
// does not couple the two packages' source layouts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { parse as parseYaml } from 'yaml'

import { workspaceRoot } from '../contract-fixtures.js'
import { classifyPublicationFailure } from '../../src/control-plane/publication-failure.js'
import { RUNNER_PUBLISH_ERROR_CODES } from '../../src/runner/publish-error-code.js'

/** The `PUBLICATION_STEP_*` members of the contract's `ErrorResponse.code` enum. The
 * contract is the single source of truth for the vocabulary Control Plane emits. */
function publicationStepCodesFromContract(): string[] {
  const spec = parseYaml(
    readFileSync(
      path.join(workspaceRoot(), 'contracts', 'control-plane-api', 'openapi.yaml'),
      'utf8'
    )
  ) as {
    components?: { schemas?: { ErrorResponse?: { properties?: { code?: { enum?: unknown[] } } } } }
  }
  const values = spec.components?.schemas?.ErrorResponse?.properties?.code?.enum ?? []
  return values
    .filter((value): value is string => typeof value === 'string')
    .filter((value) => value.startsWith('PUBLICATION_STEP_'))
    .sort()
}

test('every Control Plane publication-step code is known and terminal', () => {
  const codes = publicationStepCodesFromContract()
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
