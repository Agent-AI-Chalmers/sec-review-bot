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
})
