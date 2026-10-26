// Review Runs's terminal publication-step codes must stay terminal here.
//
// `classifyPublicationFailure` decides retry vs. terminal from the string `code` that crosses
// the REST boundary (a 409 with `code`). If Review Runs emits a new deterministic code this
// package does not recognize, it falls through to `retry: true` and the Execution Worker retries the
// same stored run forever. Read the codes from Review Runs's contract — the shared,
// single source both packages derive from — rather than from its source tree, so this test
// does not couple the two packages' source layouts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { parse as parseYaml } from 'yaml'

import { workspaceRoot } from '../contract-fixtures.js'
import { classifyPublicationFailure } from '../../src/review-runs/publication-failure.js'
import { EXECUTION_PUBLISH_ERROR_CODES } from '../../src/execution/publish-error-code.js'

/** The `PUBLICATION_STEP_*` members of the contract's `ErrorResponse.code` enum. The
 * contract is the single source of truth for the vocabulary Review Runs emits. */
function publicationStepCodesFromContract(): string[] {
  const spec = parseYaml(
    readFileSync(
      path.join(
        workspaceRoot(),
        'contracts',
        'review-runs-api',
        'v1',
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

test('every Review Runs publication-step code is known and terminal when refused', () => {
  const codes = publicationStepCodesFromContract()
  assert.ok(codes.length > 0, 'expected publication-step codes')

  const known = new Set<string>(Object.values(EXECUTION_PUBLISH_ERROR_CODES))
  for (const code of codes) {
    assert.ok(
      known.has(code),
      `${code} is missing from EXECUTION_PUBLISH_ERROR_CODES`
    )
    // Review Runs answers every one of these with a 409 (server.ts maps
    // `DeterministicReviewRunError` to 409), and a stored run re-enters the same condition on
    // every claim. A missing classification would resolve to `retry: true` and loop forever, so
    // this asserts the exact shape the client produces for that refusal.
    assert.strictEqual(
      classifyPublicationFailure({ code, status: 409 }).retry,
      false,
      `${code} must be classified as terminal (retry: false)`
    )
  }

  // The exhaustion signal is the one code whose meaning depends on who answered: a proxy in front
  // of Review Runs can relay it without Review Runs having decided anything, and a publication
  // whose steps were never refused must not be ended by that. The step-set codes above are
  // deliberately status-blind instead — retrying a changed step set re-derives the same set
  // forever — so this exception is about exhaustion alone, not a general rule for the enum.
  assert.strictEqual(
    classifyPublicationFailure({
      code: EXECUTION_PUBLISH_ERROR_CODES.publication_step_retry_exhausted,
      status: 503
    }).retry,
    true,
    'an exhaustion signal relayed by a proxy says nothing about the step budget'
  )
})
