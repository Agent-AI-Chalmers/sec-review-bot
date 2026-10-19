// Fan-out reads used to skip the `initialize()` guard that every other read has, so a
// coordinator started before initialization would query tables that do not exist yet.
import assert from 'node:assert/strict'
import test from 'node:test'

import { ReviewRunStore } from '../src/index.js'

test('fan-out reads refuse to run before initialize()', async () => {
  const store = new ReviewRunStore({
    connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused',
    connectorId: 'readiness'
  })
  await assert.rejects(() => store.listSubmissionRecoveries(), /initialize/)
  await assert.rejects(() => store.listActiveRuns(), /initialize/)
  // Added later than the two above; every read that reaches the pool belongs to this guard, not
  // only the fan-out ones that originally motivated it.
  await assert.rejects(
    () => store.listBlockedPreparationExpiries(),
    /initialize/
  )
  await assert.rejects(() => store.listEvents('run-1'), /initialize/)
  await assert.rejects(() => store.runExists('run-1'), /initialize/)
})
