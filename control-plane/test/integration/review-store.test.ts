import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import Fastify from 'fastify'
import { Pool } from 'pg'

import { ReviewRunStore } from '../../src/index.js'

process.env.NODE_ENV = 'test'
const { CONTROL_PLANE_FASTIFY_OPTIONS, registerControlPlaneRoutes } =
  await import(new URL('../../dist/server.js', import.meta.url).href)

function databaseUrl() {
  const value = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  if (!value) throw new Error('TEST_DATABASE_URL or DATABASE_URL is required.')
  return value
}

test('Control Plane store initializes its schema and deduplicates ingress', async () => {
  const store = new ReviewRunStore({
    connectionString: databaseUrl(),
    connectorId: `control-plane-test:${randomUUID()}`
  })
  await store.initialize()
  try {
    const ingressKey = `delivery:${randomUUID()}`
    const first = await store.admitReviewRun({
      run_id: `run-${randomUUID()}`,
      workflow: 'issue-review',
      publish_context: {},
      ingress_kind: 'github_webhook',
      ingress_key: ingressKey
    })
    const replay = await store.admitReviewRun({
      run_id: `discarded-${randomUUID()}`,
      workflow: 'issue-review',
      publish_context: {},
      ingress_kind: 'github_webhook',
      ingress_key: ingressKey
    })

    assert.strictEqual(first.created, true)
    assert.strictEqual(replay.created, false)
    assert.strictEqual(replay.record.run_id, first.record.run_id)
  } finally {
    await store.close()
  }
})

test('Control Plane readiness route rejects a schema ledger from a newer application', async () => {
  const schema = `readiness_${randomUUID().replaceAll('-', '')}`
  const observer = new Pool({ connectionString: databaseUrl() })
  await observer.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({
    connectionString: databaseUrl(),
    options: `-c search_path=${schema},public`
  })
  const store = new ReviewRunStore({
    pool,
    connectorId: `control-plane-test:${randomUUID()}`
  })
  const app = Fastify(CONTROL_PLANE_FASTIFY_OPTIONS)
  let poolClosed = false
  try {
    await store.initialize()
    await registerControlPlaneRoutes(app, {
      store,
      serviceToken: 'service-token',
      readToken: 'read-token'
    })
    await app.ready()
    const ready = await app.inject({ method: 'GET', url: '/readyz' })
    assert.strictEqual(ready.statusCode, 200)
    assert.deepStrictEqual(ready.json(), { status: 'ok' })
    await pool.query(
      `INSERT INTO schema_versions (version,name,checksum)
       VALUES (999999, 'newer_application', '0000000000000000000000000000000000000000000000000000000000000000')`
    )
    const unavailable = await app.inject({ method: 'GET', url: '/readyz' })
    assert.strictEqual(unavailable.statusCode, 503)
    assert.deepStrictEqual(unavailable.json(), { status: 'unavailable' })

    await pool.query('DELETE FROM schema_versions WHERE version=999999')
    await pool.query('DELETE FROM schema_versions WHERE version=1')
    const missingSchema = await app.inject({ method: 'GET', url: '/readyz' })
    assert.strictEqual(missingSchema.statusCode, 503)
    assert.deepStrictEqual(missingSchema.json(), { status: 'unavailable' })

    await pool.end()
    poolClosed = true
    const unavailablePool = await app.inject({ method: 'GET', url: '/readyz' })
    assert.strictEqual(unavailablePool.statusCode, 503)
    assert.deepStrictEqual(unavailablePool.json(), { status: 'unavailable' })
  } finally {
    await app.close()
    if (!poolClosed) await store.close()
    await observer.query(`DROP SCHEMA ${schema} CASCADE`)
    await observer.end()
  }
})

test('Control Plane store fences reads by connector', async () => {
  const runId = `run-${randomUUID()}`
  const first = new ReviewRunStore({
    connectionString: databaseUrl(),
    connectorId: `first:${randomUUID()}`
  })
  const second = new ReviewRunStore({
    connectionString: databaseUrl(),
    connectorId: `second:${randomUUID()}`
  })
  await Promise.all([first.initialize(), second.initialize()])
  try {
    await first.createPreparingReviewRun({
      run_id: runId,
      workflow: 'repository-review',
      publish_context: {}
    })
    assert.strictEqual(await second.getRun(runId), null)
  } finally {
    await Promise.all([first.close(), second.close()])
  }
})

test('run queries survive a fresh store connection and preserve stable pagination', async () => {
  const connectorId = `query-restart:${randomUUID()}`
  const first = new ReviewRunStore({
    connectionString: databaseUrl(),
    connectorId
  })
  await first.initialize()
  const runIds = [`run-${randomUUID()}`, `run-${randomUUID()}`]
  try {
    for (const run_id of runIds) {
      await first.createPreparingReviewRun({
        run_id,
        workflow: 'issue-review',
        publish_context: { private: true },
        runner_input: { secret: true }
      })
    }
  } finally {
    await first.close()
  }

  const restarted = new ReviewRunStore({
    connectionString: databaseUrl(),
    connectorId
  })
  await restarted.initialize()
  try {
    const { runs: firstPage, next_cursor: cursor } =
      await restarted.listRunsPage({ limit: 1 })
    assert.strictEqual(firstPage.length, 1)
    assert.ok(
      cursor,
      'a second run remains, so the first page must carry a cursor'
    )
    const { runs: secondPage, next_cursor: finalCursor } =
      await restarted.listRunsPage({
        limit: 1,
        cursor
      })
    assert.strictEqual(secondPage.length, 1)
    assert.notStrictEqual(secondPage[0]?.run_id, firstPage[0]?.run_id)
    assert.strictEqual(finalCursor, null)
    assert.strictEqual(
      (await restarted.getRun(runIds[0] ?? ''))?.runner_input?.secret,
      true
    )
  } finally {
    await restarted.close()
  }
})

test('run queries apply status filters before pagination limits', async () => {
  const store = new ReviewRunStore({
    connectionString: databaseUrl(),
    connectorId: `query-status:${randomUUID()}`
  })
  await store.initialize()
  try {
    const failedRunId = `run-${randomUUID()}`
    const failed = await store.createPreparingReviewRun({
      run_id: failedRunId,
      workflow: 'issue-review',
      publish_context: {}
    })
    assert.ok(failed.preparation_token)
    await store.failPreparation(failedRunId, failed.preparation_token, {
      code: 'PREPARATION_FAILED',
      message: 'failed before newer runs were admitted'
    })

    for (let index = 0; index < 2; index += 1) {
      await store.createPreparingReviewRun({
        run_id: `run-${randomUUID()}`,
        workflow: 'issue-review',
        publish_context: {}
      })
    }

    // The preparation failed before the Runner was called, so execution is `skipped`, not
    // failed; the filter narrows to exactly that terminal run.
    const { runs: skippedRuns } = await store.listRunsPage({
      execution_status: 'skipped',
      limit: 1
    })
    assert.deepStrictEqual(
      skippedRuns.map((run) => run.run_id),
      [failedRunId]
    )

    // `preparation_status` filters on the redacted preparation summary's state, which the
    // run record exposes alongside the two status axes. The two waiting runs are still
    // `preparing` (claimed); the failed one reached the terminal `failed` state.
    const { runs: failedPreparations } = await store.listRunsPage({
      preparation_status: 'failed',
      limit: 10
    })
    assert.deepStrictEqual(
      failedPreparations.map((run) => run.run_id),
      [failedRunId]
    )
    assert.strictEqual(failedPreparations[0]?.preparation?.status, 'failed')
    const { runs: preparingPreparations } = await store.listRunsPage({
      preparation_status: 'preparing',
      limit: 10
    })
    assert.strictEqual(preparingPreparations.length, 2)
    assert.ok(
      preparingPreparations.every(
        (run) => run.preparation?.status === 'preparing'
      )
    )
  } finally {
    await store.close()
  }
})

test('keyset cursors do not skip rows that share a millisecond', async () => {
  const connectorId = `query-same-ms:${randomUUID()}`
  const store = new ReviewRunStore({
    connectionString: databaseUrl(),
    connectorId
  })
  await store.initialize()
  const runIds = [`run-${randomUUID()}`, `run-${randomUUID()}`]
  const observer = new Pool({ connectionString: databaseUrl() })
  try {
    for (const run_id of runIds) {
      await store.createPreparingReviewRun({
        run_id,
        workflow: 'issue-review',
        publish_context: {}
      })
    }
    // Pin both runs to the same millisecond (different microseconds) so a
    // millisecond-truncated cursor cannot order past the second row.
    await observer.query(
      `UPDATE review_runs
       SET created_at = CASE
         WHEN run_id=$1 THEN '2026-01-01T00:00:00.111222Z'::timestamptz
         ELSE '2026-01-01T00:00:00.111888Z'::timestamptz
       END
       WHERE connector_id=$2`,
      [runIds[0], connectorId]
    )

    const { runs: firstPage, next_cursor: cursor } = await store.listRunsPage({
      limit: 1
    })
    assert.strictEqual(firstPage.length, 1)
    assert.ok(cursor)
    const { runs: secondPage } = await store.listRunsPage({ limit: 1, cursor })
    assert.strictEqual(secondPage.length, 1)
    assert.deepStrictEqual(
      [firstPage[0]?.run_id, secondPage[0]?.run_id].sort(),
      [...runIds].sort()
    )
  } finally {
    await observer.end()
    await store.close()
  }
})

test('a row the contract cannot represent is dropped from a read, not thrown', async () => {
  // `rowToRecord` throws on a stored shape the contract forbids (here an `available` artifact
  // without its reference, which only an out-of-band write can produce now that the store
  // narrows on the write path). The fan-out reads must report and skip it rather than failing
  // the whole read: a listing should still return its healthy rows, and the coordinator's
  // active-run read must still hand the runs around it to the pass.
  const connectorId = `drop-run-row:${randomUUID()}`
  const store = new ReviewRunStore({
    connectionString: databaseUrl(),
    connectorId
  })
  await store.initialize()
  const healthyId = `run-${randomUUID()}`
  const poisonedId = `run-${randomUUID()}`
  try {
    for (const runId of [healthyId, poisonedId]) {
      const admission = await store.createPreparingReviewRun({
        workflow: 'issue-review',
        run_id: runId,
        publish_context: {}
      })
      assert.ok(admission.preparation_token)
      await store.markQueued(runId, admission.preparation_token, {})
    }

    const pool = new Pool({ connectionString: databaseUrl() })
    await pool.query(
      'UPDATE review_runs SET artifact_storage=$2::jsonb WHERE run_id=$1',
      [poisonedId, JSON.stringify({ status: 'available' })]
    )
    try {
      const page = await store.listRunsPage({ limit: 10 })
      assert.deepStrictEqual(
        page.dropped.map((entry) => entry.run_id),
        [poisonedId],
        'the unrepresentable row is reported'
      )
      assert.deepStrictEqual(
        page.runs.map((entry) => entry.run_id),
        [healthyId],
        'the healthy row is still listed'
      )

      const active = await store.listActiveRuns()
      assert.deepStrictEqual(
        active.dropped.map((entry) => entry.run_id),
        [poisonedId],
        'the poisoned active run is reported, not thrown'
      )
      assert.deepStrictEqual(
        active.runs.map((entry) => entry.run_id),
        [healthyId],
        'the pass still receives the healthy active run'
      )
    } finally {
      await pool.end()
    }
  } finally {
    await store.close()
  }
})
