// Keep the hand-written contract's error-code enum and the server's keyed map in step.
//
// The openapi.yaml `ErrorResponse.code` enum owns the publication-step strings; `errors.ts`
// keeps semantic keys and pins values to the contract at compile time (the `satisfies`), but
// the reverse direction — that every contract code has a key here, and none is missing or
// extra — has to be asserted at runtime, since the keys are not the code strings.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { parse as parseYaml } from 'yaml'

import { PUBLICATION_STEP_ERROR_CODES } from '../src/errors.js'
import {
  ERROR_RESPONSE_CODES_FROM_CONTRACT,
  PUBLICATION_STEP_ERROR_CODES_FROM_CONTRACT
} from '../src/error-codes-generated.js'
import { REVIEW_RUNS_API_SPEC_PATH as SPEC_PATH } from './generated-paths.js'

test('the keyed error-code map covers exactly the contract enum', () => {
  const fromKeys = Object.values(PUBLICATION_STEP_ERROR_CODES).sort()
  const fromContract = [...PUBLICATION_STEP_ERROR_CODES_FROM_CONTRACT].sort()

  assert.deepStrictEqual(
    fromKeys,
    fromContract,
    'PUBLICATION_STEP_ERROR_CODES and the contract enum have drifted'
  )
})

test('the closed error-code set is exactly the contract enum', () => {
  // The server refuses to emit a code outside `ERROR_RESPONSE_CODES_FROM_CONTRACT`, so this
  // array is a security control rather than a convenience list: a code missing from it is
  // silently stripped from a response as if it were an internal detail, and the caller loses
  // the machine-readable reason. Read the enum from openapi.yaml itself (not from the
  // generator) so this compares the published contract against the emitted array.
  const spec = parseYaml(readFileSync(SPEC_PATH, 'utf8')) as {
    components?: {
      schemas?: {
        ErrorResponse?: { properties?: { code?: { enum?: unknown[] } } }
      }
    }
  }
  const enumValues =
    spec.components?.schemas?.ErrorResponse?.properties?.code?.enum ?? []

  assert.deepStrictEqual(
    [...ERROR_RESPONSE_CODES_FROM_CONTRACT].sort(),
    [...(enumValues as string[])].sort(),
    'ERROR_RESPONSE_CODES_FROM_CONTRACT must list every contract code and nothing else'
  )
})
