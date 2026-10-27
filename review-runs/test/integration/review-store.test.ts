import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import Fastify from 'fastify'
import { Pool } from 'pg'

import { ReviewRunStore } from '../../src/index.js'

process.env.NODE_ENV = 'test'
const { REVIEW_RUNS_FASTIFY_OPTIONS, registerReviewRunsRoutes } = await import(
  new URL('../../dist/server.js', import.meta.url).href
)

function databaseUrl() {
  const value = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  if (!value) throw new Error('TEST_DATABASE_URL or DATABASE_URL is required.')
  return value
}

test('an axis row cannot be written under a connector the trunk does not own', async () => {
  // Reads join each axis on `connector_id`, and publication is an inner join. A row stored under
  // the wrong connector would therefore be invisible to those reads: the run would look like it
  // had a missing axis and be reported as corrupt, or vanish entirely, long after the bad write.
  // The composite foreign key turns that into a rejected write instead.
  const store = new ReviewRunStore({
    connectionString: databaseUrl(),
    connectorId: `review-runs-test:${randomUUID()}`
  })
  await store.initialize()
  const pool = new Pool({ connectionString: databaseUrl() })
  try {
    const runId = `run-${randomUUID()}`
    await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    // Delete the axis rows first so the insert below cannot fail on the primary key; the only
    // thing left to reject it is the connector the trunk owns.
    for (const table of [
      'executions',
      'preparations',
      'publications'
    ] as const) {
      await pool.query(`DELETE FROM ${table} WHERE run_id=$1`, [runId])
    }
    for (const table of [
      'executions',
      'preparations',
      'publications'
    ] as const) {
      await assert.rejects(
        pool.query(
          `INSERT INTO ${table} (run_id, connector_id, status${
            table === 'publications'
              ? ', input'
              : table === 'preparations'
                ? ', input_version, input'
                : ''
          }) VALUES ($1, 'intruder', 'pending'${
            table === 'publications'
              ? ", '{}'::jsonb"
              : table === 'preparations'
                ? ", 'v1', '{}'::jsonb"
                : ''
          })`,
          [runId]
        ),
        /violates foreign key constraint/,
        `${table} must reject a connector its trunk does not own`
      )
    }
    // The two append/progress tables carry the same connector fence. They are not lifecycle
    // axes, but both are read with a connector filter (`listPublicationSteps`, `listEvents`), so
    // a row under the wrong connector would disappear from the run instead of being rejected.
    await assert.rejects(
      pool.query(
        `INSERT INTO publication_steps (connector_id, run_id, step_key, status)
         VALUES ('intruder', $1, 'step', 'pending')`,
        [runId]
      ),
      /violates foreign key constraint/,
      'publication_steps must reject a connector its trunk does not own'
    )
    await assert.rejects(
      pool.query(
        `INSERT INTO review_run_events (run_id, connector_id, axis, to_status)
         VALUES ($1, 'intruder', 'execution', 'pending')`,
        [runId]
      ),
      /violates foreign key constraint/,
      'review_run_events must reject a connector its trunk does not own'
    )
  } finally {
    await pool.end()
    await store.close()
  }
})

test('the failure-notice outbox is fenced to the connector that owns its preparation', async () => {
  // The notice is read by joining on connector_id, so a row stored under another connector would
  // make the run report no notice — a notice that exists but is never delivered, with
  // nothing to show it went wrong.
  const store = new ReviewRunStore({
    connectionString: databaseUrl(),
    connectorId: `review-runs-test:${randomUUID()}`
  })
  await store.initialize()
  const pool = new Pool({ connectionString: databaseUrl() })
  try {
    const runId = `run-${randomUUID()}`
    const admission = await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    // A terminal preparation failure is what creates the notice row.
    await store.failPreparation(runId, admission.preparation_token, {
      code: 'REVIEW_START_FAILED',
      message: 'boom'
    })
    const source = await pool.query<{ source_event_id: string }>(
      'SELECT source_event_id::text FROM run_notices WHERE run_id=$1',
      [runId]
    )
    const sourceEventId = source.rows[0]?.source_event_id
    assert.ok(sourceEventId)
    // Clear the real notice so the insert below cannot fail on the primary key; the connector is
    // then the only thing left that can reject it.
    await pool.query('DELETE FROM run_notices WHERE run_id=$1', [runId])
    await assert.rejects(
      pool.query(
        `INSERT INTO run_notices
           (run_id, connector_id, source_event_id, status, kind, axis)
         VALUES ($1, 'intruder', $2, 'pending', 'failure', 'preparation')`,
        [runId, sourceEventId]
      ),
      /violates foreign key constraint/,
      'a notice must not name a connector its run does not belong to'
    )

    // The reason this matters: the notice is joined on connector_id, so a row under another
    // connector is simply not found and the notice reads as absent — a notice that
    // exists, is never delivered, and leaves nothing visible to explain why. Asserting the
    // symptom, not just the rejection, is what makes the constraint's purpose checkable.
    await pool.query('DELETE FROM run_notices WHERE run_id=$1', [runId])
    await pool
      .query(
        `INSERT INTO run_notices
           (run_id, connector_id, source_event_id, status, kind, axis)
         VALUES ($1, 'intruder', $2, 'pending', 'failure', 'preparation')`,
        [runId, sourceEventId]
      )
      .catch(() => undefined)
    const stored = await pool.query(
      'SELECT connector_id FROM run_notices WHERE run_id=$1',
      [runId]
    )
    assert.strictEqual(
      stored.rowCount,
      0,
      'the wrong-connector notice was never stored'
    )
    assert.deepStrictEqual(
      (await store.getRun(runId))?.notices,
      [],
      'and so the run reports no notice rather than a phantom one'
    )
  } finally {
    await pool.end()
    await store.close()
  }
})

test('admission creates exactly one executions row alongside the run trunk', async () => {
  const store = new ReviewRunStore({
    connectionString: databaseUrl(),
    connectorId: `review-runs-test:${randomUUID()}`
  })
  await store.initialize()
  const pool = new Pool({ connectionString: databaseUrl() })
  try {
    const runId = `run-${randomUUID()}`
    await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: { repo: 'octo/example' }
    })
    // The split keeps execution state out of the trunk table, so every run must have exactly
    // one execution-row or a JOIN read would silently drop it.
    const executions = await pool.query(
      'SELECT status, started_at, claim_token, claimed_at FROM executions WHERE run_id=$1',
      [runId]
    )
    assert.strictEqual(executions.rowCount, 1)
    assert.strictEqual(executions.rows[0].status, 'pending')
    assert.strictEqual(executions.rows[0].started_at, null)
    assert.strictEqual(executions.rows[0].claim_token, null)
    assert.strictEqual(executions.rows[0].claimed_at, null)

    // Publication input belongs to the publication axis, like the preparation and execution
    // inputs belong to theirs.
    const publication = await pool.query(
      'SELECT input FROM publications WHERE run_id=$1',
      [runId]
    )
    assert.deepStrictEqual(publication.rows[0].input, { repo: 'octo/example' })

    // The trunk keeps only identity and cross-axis fields; execution columns must not be there.
    const trunk = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='review_runs'`
    )
    const trunkColumns = trunk.rows.map(
      (row: { column_name: string }) => row.column_name
    )
    for (const moved of [
      'runner_status',
      'execution_input',
      'runner_failure_code',
      'artifact_storage',
      'workflow_result',
      'recovery_claim_token',
      'started_at',
      'publish_context'
    ]) {
      assert.ok(
        !trunkColumns.includes(moved),
        `review_runs must not keep execution column ${moved}`
      )
    }
  } finally {
    await pool.end()
    await store.close()
  }
})

for (const axis of ['executions', 'preparations'] as const) {
  test(`a run missing its ${axis} row is reported, not silently returned`, async () => {
    // Admission writes the trunk and both axis rows in one transaction, so a missing axis means
    // a corrupt or partially restored database rather than a legitimate record. The read must
    // report it instead of returning a row that merely looks like it has no such axis: for
    // preparation that would be indistinguishable from a valid `preparation: null`.
    const dropped: Array<{ run_id: string; error: unknown }> = []
    const store = new ReviewRunStore({
      connectionString: databaseUrl(),
      connectorId: `review-runs-test:${randomUUID()}`,
      onDroppedRunRow: (entry) => dropped.push(entry)
    })
    await store.initialize()
    const pool = new Pool({ connectionString: databaseUrl() })
    try {
      const runId = `run-${randomUUID()}`
      await store.createPreparingReviewRun({
        workflow: 'issue-review',
        run_id: runId,
        publish_context: {}
      })
      // Simulate a corrupt or partially restored database: delete one axis row and commit, so
      // the read (which runs on its own pooled connection) sees it. The row is removed by the
      // fixture cleanup below, so this never leaks into another test.
      await pool.query(`DELETE FROM ${axis} WHERE run_id=$1`, [runId])

      const page = await store.listRunsPage({ limit: 10 })
      assert.ok(
        page.dropped.some((entry) => entry.run_id === runId),
        'the corrupt run is reported in dropped'
      )
      assert.ok(
        !page.runs.some((run) => run.run_id === runId),
        'the corrupt run is not returned as a valid record'
      )
      // A status filter must not be what hides corruption. A newly admitted run's preparation is
      // `preparing`, so filtering on that state still has to surface the row as dropped: the
      // filter selects on a value, and a corrupt row must be reported rather than filtered away.
      const matching = await store.listRunsPage({
        preparation_status: 'preparing',
        limit: 10
      })
      assert.ok(
        !matching.runs.some((run) => run.run_id === runId) &&
          matching.dropped.some((entry) => entry.run_id === runId),
        'a status filter reports the corrupt row instead of hiding it'
      )
      // The single-run read answers `null`, the same as an unknown id, so it reports the fault
      // through the callback rather than leaving corruption to look like a missing run.
      // An unknown id must NOT report corruption; only a stored row that fails to project does.
      assert.strictEqual(
        await store.getRun(`run-unknown-${randomUUID()}`),
        null
      )
      assert.ok(
        !dropped.some((entry) => entry.run_id.startsWith('run-unknown-')),
        'an unknown run id is not reported as corruption'
      )
      assert.strictEqual(await store.getRun(runId), null)
      assert.ok(
        dropped.some((entry) => entry.run_id === runId),
        'the single-run read reports the corrupt row'
      )
    } finally {
      await pool.end()
      await store.close()
    }
  })
}

test('Review Runs store initializes its schema and deduplicates ingress', async () => {
  const store = new ReviewRunStore({
    connectionString: databaseUrl(),
    connectorId: `review-runs-test:${randomUUID()}`
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

test('Review Runs readiness route rejects a schema ledger from a newer application', async () => {
  const schema = `readiness_${randomUUID().replaceAll('-', '')}`
  const observer = new Pool({ connectionString: databaseUrl() })
  await observer.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({
    connectionString: databaseUrl(),
    options: `-c search_path=${schema},public`
  })
  const store = new ReviewRunStore({
    pool,
    connectorId: `review-runs-test:${randomUUID()}`
  })
  const app = Fastify(REVIEW_RUNS_FASTIFY_OPTIONS)
  let poolClosed = false
  try {
    await store.initialize()
    await registerReviewRunsRoutes(app, {
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

test('Review Runs store fences reads by connector', async () => {
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
        execution_input: { secret: true }
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
      (await restarted.getRun(runIds[0] ?? ''))?.execution_input?.secret,
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

    // The preparation failed before the Execution was called, so execution is `skipped`, not
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
    const { runs: githubRuns } = await store.listRunsPage({
      source_platform: 'github',
      limit: 10
    })
    assert.strictEqual(githubRuns.length, 3)
    assert.ok(githubRuns.every((run) => run.source_platform === 'github'))
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
      'UPDATE executions SET artifact_storage=$2::jsonb WHERE run_id=$1',
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

test('a submission for an unknown run is a 404, not a server fault', async () => {
  // `markQueued` used to throw a bare Error when the run was missing, which the HTTP layer
  // reported as 500 and hid the fact that the caller's run id was wrong. A missing run is the
  // caller's own input, so it must surface as 404.
  const store = new ReviewRunStore({
    connectionString: databaseUrl(),
    connectorId: `review-runs-test:${randomUUID()}`
  })
  await store.initialize()
  try {
    await assert.rejects(
      store.markQueued(`missing-${randomUUID()}`, randomUUID(), {}),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        error.statusCode === 404
    )
  } finally {
    await store.close()
  }
})

test('an execution may hold a recovery claim only while uncertain', async () => {
  // `preparations` ties its claim token to `preparing`; `executions` ties it to `uncertain` the
  // same way. The claim is what fences a replayed submission, so leaving one on a `queued` or
  // terminal row would be a stale lease no read path expects. Every write path already clears the
  // token, so the database enforces the shape rather than trusting each path to remember.
  const store = new ReviewRunStore({
    connectionString: databaseUrl(),
    connectorId: `review-runs-test:${randomUUID()}`
  })
  await store.initialize()
  const pool = new Pool({ connectionString: databaseUrl() })
  try {
    const runId = `run-${randomUUID()}`
    await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    // A token on `pending` is rejected.
    await assert.rejects(
      pool.query(
        `UPDATE executions SET claim_token=$2, claimed_at=clock_timestamp()
         WHERE run_id=$1`,
        [runId, randomUUID()]
      ),
      /violates check constraint/,
      'a pending execution must not carry a recovery claim'
    )
    // A token on `uncertain` is accepted: that is the state a recovery claims.
    await pool.query(
      `UPDATE executions SET status='uncertain' WHERE run_id=$1`,
      [runId]
    )
    await pool.query(
      `UPDATE executions SET claim_token=$2, claimed_at=clock_timestamp()
       WHERE run_id=$1`,
      [runId, randomUUID()]
    )
    // Moving out of `uncertain` without clearing the token is rejected.
    await assert.rejects(
      pool.query(
        `UPDATE executions SET status='queued', started_at=clock_timestamp() WHERE run_id=$1`,
        [runId]
      ),
      /violates check constraint/,
      'leaving uncertain must clear the recovery claim'
    )
  } finally {
    await pool.end()
    await store.close()
  }
})
