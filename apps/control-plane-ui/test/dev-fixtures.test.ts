import test from 'node:test'
import assert from 'node:assert/strict'

test('dev fixtures only describe reachable run states', async () => {
  // dev-fixtures.ts validates every generated run at import time and throws on a
  // combination the Control Plane cannot produce (for example a failed execution
  // whose publication is still `pending`). Importing it is therefore the assertion:
  // this test exists so an unreachable fixture fails CI instead of silently
  // showing operators a state that cannot happen.
  await assert.doesNotReject(() => import('../dev-fixtures.js'))
})
