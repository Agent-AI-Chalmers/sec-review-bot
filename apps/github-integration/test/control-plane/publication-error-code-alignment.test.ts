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
      path.join(
        workspaceRoot(),
        'contracts',
        'control-plane-api',
        'openapi.yaml'
      ),
      'utf8'
    )
  ) as {
    components?: {
      schemas?: {
        ErrorResponse?: { properties?: { code?: { enum?: unknown[] } } }
      }
    }
  }
  const values =
    spec.components?.schemas?.ErrorResponse?.properties?.code?.enum ?? []
  return values
    .filter((value): value is string => typeof value === 'string')
    .filter((value) => value.startsWith('PUBLICATION_STEP_'))
    .sort()
}

/** Control Plane's own terminal publication-step codes: every `PUBLICATION_STEP_*` code except
 * the exhaustion signal, which is also what a request that never reached the service carries.
 * See the retry assertions below for why that one cannot be classified from the code alone. */
const DETERMINISTIC_CODES = (codes: string[]): string[] =>
  codes.filter(
    (code) =>
      code !== RUNNER_PUBLISH_ERROR_CODES.publication_step_retry_exhausted
  )

test('every Control Plane publication-step code is known and classified', () => {
  const codes = publicationStepCodesFromContract()
  assert.ok(codes.length > 0, 'expected publication-step codes')

  const known = new Set<string>(Object.values(RUNNER_PUBLISH_ERROR_CODES))
  for (const code of DETERMINISTIC_CODES(codes)) {
    assert.ok(
      known.has(code),
      `${code} is missing from RUNNER_PUBLISH_ERROR_CODES`
    )
    // These are refusals: a stored run re-enters the same condition on every claim, so a
    // missing classification here would resolve to `retry: true` and loop forever.
    assert.strictEqual(
      classifyPublicationFailure({ code, status: 409 }).retry,
      false,
      `${code} must be classified as terminal (retry: false)`
    )
  }

  // The exhaustion signal is terminal only when Control Plane answered it. The same code reaches
  // this package from a claim call that timed out, and from one a proxy answered with a 5xx; a
  // publication whose steps were never refused must not be ended by that.
  const exhausted = RUNNER_PUBLISH_ERROR_CODES.publication_step_retry_exhausted
  assert.ok(codes.includes(exhausted))
  assert.strictEqual(
    classifyPublicationFailure({ code: exhausted, status: 409 }).retry,
    false,
    'a refusal with no attempts left is terminal'
  )
  assert.strictEqual(
    classifyPublicationFailure({ code: exhausted }).retry,
    true,
    'the same code from a request that never got an answer must stay retryable'
  )
  assert.strictEqual(
    classifyPublicationFailure({ code: exhausted, status: 503 }).retry,
    true,
    'a proxy answer says nothing about the step budget'
  )
})
