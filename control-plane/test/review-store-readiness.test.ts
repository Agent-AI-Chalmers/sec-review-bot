// Fan-out reads used to skip the `initialize()` guard that every other read has, so a
// coordinator started before initialization would query tables that do not exist yet.
import assert from 'node:assert/strict'
import test from 'node:test'

import { Pool } from 'pg'

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
  await assert.rejects(() => store.listParkedRuns(), /initialize/)
  await assert.rejects(() => store.listEvents('run-1'), /initialize/)
  await assert.rejects(() => store.runExists('run-1'), /initialize/)
})

test('an idle-client pool error is reported instead of crashing the process', async () => {
  // `pg` emits `error` on the pool when an idle client's connection drops. An EventEmitter that
  // emits `error` with no listener throws, so a database restart killed the whole control plane --
  // and, under `docker compose up --abort-on-container-failure`, every other service with it.
  // The pool needs a listener that survives the event; the next query either reconnects or fails
  // on its own.
  //
  // Why this survived for months before anyone saw it: the event only fires when a socket is
  // severed while the pool still believes the client is usable. A connection pg-pool reaps itself
  // (idleTimeoutMillis, default 10s, only while above `min`) closes cleanly and emits nothing. So
  // a stable local stack, with the coordinator polling every 15s, never reaches this path. It took
  // dropping the Postgres data directory -- which restarts the server and severs every existing
  // connection at once -- to surface it. The pool also briefly holds more than one connection
  // while the coordinator's three `claim*` calls run concurrently, which is why the death landed
  // during a poll rather than at startup.
  //
  // A restart severs every pooled connection, so this can log several times in a row. That is
  // deliberate: each report corresponds to a real dropped connection, and suppressing them would
  // hide how unhealthy the dependency is at that moment.
  //
  // The pool is injected rather than reached through the store, so the test exercises the same
  // constructor argument production could use and needs no cast into a private field.
  const pool = new Pool({
    connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused'
  })
  const store = new ReviewRunStore({ pool, connectorId: 'readiness' })
  const reported: unknown[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    reported.push(args)
  }
  try {
    // Without a registered listener this throws `Unhandled 'error' event` and fails the test,
    // which is exactly the production crash.
    pool.emit('error', new Error('Connection terminated unexpectedly'))
  } finally {
    console.error = originalError
  }

  assert.equal(reported.length, 1)
  assert.equal(reported[0] instanceof Array, true)
  const [event] = reported[0] as [string]
  assert.equal(event, 'control_plane_pool_idle_client_error')

  await store.close()
})
