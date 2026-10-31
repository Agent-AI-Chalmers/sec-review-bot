import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { ReviewRunStore } from '../../src/persistence/review-run-store.js'

async function fixture() {
  const connectionString = process.env.TEST_DATABASE_URL
  assert.ok(connectionString)
  const connectorId = `input-publication:${randomUUID()}`
  const store = new ReviewRunStore({ connectionString, connectorId })
  await store.initialize()
  const pool = new Pool({ connectionString })
  const admitted = await store.admissions.create({
    workflow: 'issue-review',
    run_id: randomUUID(),
    publish_context: {},
    preparation_input_version: 'v1',
    preparation_input: { kind: 'test' }
  })
  assert.ok(admitted.preparation_token)
  const runId = admitted.record.run_id
  const token = admitted.preparation_token
  const reference = {
    uri: `s3://bucket/runs/${runId}/input/${'a'.repeat(64)}/input-bundle.v1.tar.zst`,
    digest: `sha256:${'a'.repeat(64)}`,
    media_type: 'application/tar+zstd' as const,
    size_bytes: 10
  }
  const intent = {
    reference,
    input: { input_bundle: reference, snapshot: 'original' },
    publish_context: { target: 'original' }
  }
  return {
    store,
    pool,
    runId,
    token,
    intent,
    async close() {
      await pool.end()
      await store.close()
    }
  }
}

test('selection requires published identical input and commits candidate, input and context together', async () => {
  const f = await fixture()
  try {
    const { store, runId, token, intent } = f
    await assert.rejects(
      store.submissionTransitions.savePreparedSubmission(
        runId,
        token,
        intent.publish_context,
        intent.input
      ),
      /no matching published candidate/
    )
    await store.inputBundleCandidates.reserve(runId, token, intent)
    await assert.rejects(
      store.submissionTransitions.savePreparedSubmission(
        runId,
        token,
        intent.publish_context,
        intent.input
      ),
      /no matching published candidate/
    )
    await store.inputBundleCandidates.settle(
      runId,
      token,
      intent.reference.digest,
      'present'
    )
    // The execution update is made ineligible after presence confirmation. Candidate selection
    // must roll back too, rather than leaving a selected object with no accepted input.
    await f.pool.query(
      `UPDATE executions SET status='skipped', finished_at=clock_timestamp() WHERE run_id=$1`,
      [runId]
    )
    await assert.rejects(
      store.submissionTransitions.savePreparedSubmission(
        runId,
        token,
        intent.publish_context,
        intent.input
      ),
      /outside pending/
    )
    assert.equal(
      (await store.inputBundleCandidates.list(runId, token))[0]?.status,
      'present'
    )
    await f.pool.query(
      `UPDATE executions SET status='pending', finished_at=NULL WHERE run_id=$1`,
      [runId]
    )
    await store.submissionTransitions.savePreparedSubmission(
      runId,
      token,
      intent.publish_context,
      intent.input
    )
    // A lost commit response is answered by exact replay, without changing the accepted request.
    await store.submissionTransitions.savePreparedSubmission(
      runId,
      token,
      intent.publish_context,
      intent.input
    )
    await assert.rejects(
      store.submissionTransitions.savePreparedSubmission(
        runId,
        token,
        intent.publish_context,
        { ...intent.input, snapshot: 'changed' }
      ),
      /no matching published candidate/
    )
    await assert.rejects(
      store.inputBundleCandidates.settle(
        runId,
        token,
        intent.reference.digest,
        'abandoned'
      )
    )
    const rows = await f.pool.query(
      `SELECT c.status,e.input,p.input AS context FROM input_bundle_candidates c JOIN executions e USING(run_id) JOIN publications p USING(run_id) WHERE c.run_id=$1`,
      [runId]
    )
    assert.deepStrictEqual(rows.rows, [
      {
        status: 'selected',
        input: intent.input,
        context: intent.publish_context
      }
    ])
  } finally {
    await f.close()
  }
})

test('expiry fences reserve, confirmation and selection before the sweep; takeover recovers the intent', async () => {
  const f = await fixture()
  try {
    await f.store.inputBundleCandidates.reserve(f.runId, f.token, f.intent)
    await f.pool.query(
      `UPDATE preparations SET claimed_at=clock_timestamp()-interval '1 hour' WHERE run_id=$1`,
      [f.runId]
    )
    assert.equal(await f.store.preparations.renewClaim(f.runId, f.token), false)
    await assert.rejects(
      f.store.inputBundleCandidates.reserve(f.runId, f.token, f.intent),
      /claim was lost/
    )
    await assert.rejects(
      f.store.inputBundleCandidates.settle(
        f.runId,
        f.token,
        f.intent.reference.digest,
        'present'
      ),
      /claim was lost/
    )
    await assert.rejects(
      f.store.submissionTransitions.savePreparedSubmission(
        f.runId,
        f.token,
        f.intent.publish_context,
        f.intent.input
      ),
      /claim was lost/
    )
    await f.store.preparations.expireStale()
    const next = await f.store.preparations.claimNext()
    assert.ok(next)
    const candidates = await f.store.inputBundleCandidates.list(
      f.runId,
      next.claim_token
    )
    assert.deepStrictEqual(candidates[0]?.input, f.intent.input)
    await f.store.inputBundleCandidates.settle(
      f.runId,
      next.claim_token,
      f.intent.reference.digest,
      'present'
    )
    await f.store.submissionTransitions.savePreparedSubmission(
      f.runId,
      next.claim_token,
      f.intent.publish_context,
      f.intent.input
    )
    await assert.rejects(
      f.store.inputBundleCandidates.settle(
        f.runId,
        f.token,
        f.intent.reference.digest,
        'present'
      ),
      /claim was lost/
    )
  } finally {
    await f.close()
  }
})

test('reservation replay is immutable and connector/run ownership cannot be crossed', async () => {
  const f = await fixture()
  try {
    const first = await f.store.inputBundleCandidates.reserve(
      f.runId,
      f.token,
      f.intent
    )
    assert.deepStrictEqual(
      await f.store.inputBundleCandidates.reserve(f.runId, f.token, f.intent),
      first
    )
    await assert.rejects(
      f.store.inputBundleCandidates.reserve(f.runId, f.token, {
        ...f.intent,
        publish_context: { target: 'changed' }
      }),
      /conflicts/
    )
    const intruder = new ReviewRunStore({
      connectionString: process.env.TEST_DATABASE_URL!,
      connectorId: 'intruder'
    })
    await intruder.initialize()
    try {
      await assert.rejects(
        intruder.inputBundleCandidates.list(f.runId, f.token),
        /claim was lost/
      )
    } finally {
      await intruder.close()
    }
    await assert.rejects(
      f.store.inputBundleCandidates.reserve(randomUUID(), f.token, f.intent),
      /does not match its run/
    )
    await f.store.preparations.fail(f.runId, f.token, {
      message: 'terminal failure'
    })
    const result = await f.pool.query(
      'SELECT status FROM input_bundle_candidates WHERE run_id=$1',
      [f.runId]
    )
    assert.equal(result.rows[0]?.status, 'abandoned')
  } finally {
    await f.close()
  }
})

test('takeover wins against a reservation waiting for its preparation lock', async () => {
  const f = await fixture()
  const blocker = await f.pool.connect()
  try {
    await blocker.query('BEGIN')
    await blocker.query(
      'SELECT run_id FROM preparations WHERE run_id=$1 FOR UPDATE',
      [f.runId]
    )
    const rejected = assert.rejects(
      f.store.inputBundleCandidates.reserve(f.runId, f.token, f.intent),
      /claim was lost/
    )
    await blocker.query(
      `UPDATE preparations SET claim_token=$2 WHERE run_id=$1`,
      [f.runId, randomUUID()]
    )
    await blocker.query('COMMIT')
    await rejected
    const rows = await f.pool.query(
      'SELECT * FROM input_bundle_candidates WHERE run_id=$1',
      [f.runId]
    )
    assert.equal(rows.rowCount, 0)
  } finally {
    blocker.release()
    await f.close()
  }
})

test('publication operations cross the authenticated HTTP contract with real PostgreSQL', async () => {
  const f = await fixture()
  const { default: Fastify } = await import('fastify')
  const { registerReviewRunsRoutes, REVIEW_RUNS_FASTIFY_OPTIONS } =
    await import(
      new URL('../../dist/http/server-surface.js', import.meta.url).href
    )
  const app = Fastify(REVIEW_RUNS_FASTIFY_OPTIONS)
  try {
    await registerReviewRunsRoutes(app, {
      store: f.store,
      serviceToken: 'publication-test',
      readToken: 'reader-test'
    })
    const url = `/v1/runs/${f.runId}/input-bundle-candidates`
    const request = {
      method: 'POST' as const,
      url,
      headers: { authorization: 'Bearer publication-test' },
      payload: { token: f.token, ...f.intent }
    }
    assert.equal(
      (
        await app.inject({
          ...request,
          headers: { authorization: 'Bearer reader-test' }
        })
      ).statusCode,
      401
    )
    assert.equal((await app.inject(request)).statusCode, 200)
    const listed = await app.inject({
      ...request,
      url: `${url}/reconcile`,
      payload: { token: f.token }
    })
    assert.equal(listed.statusCode, 200)
    assert.deepStrictEqual(listed.json()[0].input, f.intent.input)
    assert.equal(
      (
        await app.inject({
          ...request,
          url: `${url}/settle`,
          payload: {
            token: f.token,
            digest: f.intent.reference.digest,
            status: 'present'
          }
        })
      ).statusCode,
      200
    )
    const invalid = await app.inject({
      ...request,
      payload: {
        ...request.payload,
        reference: { ...f.intent.reference, size_bytes: -1 }
      }
    })
    assert.equal(invalid.statusCode, 400)
  } finally {
    await app.close()
    await f.close()
  }
})
