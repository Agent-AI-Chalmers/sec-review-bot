// Keep the hand-written contract's error-code enum and the server's keyed map in step.
//
// The openapi.yaml `ErrorResponse.code` enum owns the publication-step strings; `errors.ts`
// keeps semantic keys and pins values to the contract at compile time (the `satisfies`), but
// the reverse direction — that every contract code has a key here, and none is missing or
// extra — has to be asserted at runtime, since the keys are not the code strings.
import assert from 'node:assert/strict'
import test from 'node:test'

import { PUBLICATION_STEP_ERROR_CODES } from '../src/errors.js'
import { PUBLICATION_STEP_ERROR_CODES_FROM_CONTRACT } from '../src/error-codes-generated.js'

test('the keyed error-code map covers exactly the contract enum', () => {
  const fromKeys = Object.values(PUBLICATION_STEP_ERROR_CODES).sort()
  const fromContract = [...PUBLICATION_STEP_ERROR_CODES_FROM_CONTRACT].sort()

  assert.deepEqual(
    fromKeys,
    fromContract,
    'PUBLICATION_STEP_ERROR_CODES and the contract enum have drifted'
  )
})
