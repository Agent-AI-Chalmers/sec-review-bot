import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'

import { ReviewRunStore } from '../../src/index.js'

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

function requireTestDatabase(): string {
  if (!connectionString)
    throw new Error('TEST_DATABASE_URL is required for PostgreSQL store tests.')
  return connectionString
}

function connectorId(): string {
  return `test:${randomUUID()}`
}

async function createStore(
  options: { connectorId?: string; claimTimeoutMs?: number } = {}
): Promise<ReviewRunStore> {
  const store = new ReviewRunStore({
    connectionString: requireTestDatabase(),
    connectorId: options.connectorId ?? connectorId(),
    ...(options.claimTimeoutMs === undefined ? {} : { claimTimeoutMs: options.claimTimeoutMs })
  })
  await store.initialize()
  return store
}

async function createQueuedRun(
  store: ReviewRunStore,
  runId = `run-${randomUUID()}`
): Promise<string> {
  const context = {}
  const admission = await store.create_preparing_review_run({
    workflow: 'issue-review',
    run_id: runId,
    publish_context: context
  })
  assert.ok(admission.preparation_token)
  await store.mark_queued(runId, admission.preparation_token, context)
  return runId
}

async function createSuccessfulRun(
  store: ReviewRunStore,
  runId = `run-${randomUUID()}`
): Promise<string> {
  await createQueuedRun(store, runId)
  assert.equal(
    await store.recordRunnerSuccess(runId, { run_id: runId }, { status: 'unavailable' }),
    true
  )
  return runId
}

test('ReviewRunStore prevents cross-connector access to a globally unique run identity', async () => {
  const connectorA = connectorId()
  const connectorB = connectorId()
  const runId = `run-shared-${randomUUID()}`
  const first = await createStore({ connectorId: connectorA })
  const second = await createStore({ connectorId: connectorB })
  try {
    await createQueuedRun(first, runId)

    assert.equal((await first.getRun(runId))?.run_id, runId)
    // run_id is currently a global primary key, while connector_id fences
    // reads and claims. A second connector must not create or see the first
    // connector's run under that identity.
    await assert.rejects(
      createQueuedRun(second, runId),
      /duplicate key value violates unique constraint/
    )
    assert.equal(await second.getRun(runId), null)
    assert.equal((await first.listActiveRuns()).length, 1)
    assert.equal((await second.listActiveRuns()).length, 0)
    assert.equal(await first.claimPublication(runId), null)
    await first.recordRunnerSuccess(runId, { run_id: runId }, { status: 'unavailable' })
    assert.notEqual(await first.claimPublication(runId), null)
    assert.equal(await second.claimPublication(runId), null)
  } finally {
    await first.close()
    await second.close()
  }
})

test('ReviewRunStore persists queued runs and keeps preparing runs out of polling', async () => {
  const store = await createStore()
  try {
    const queuedId = await createQueuedRun(store)
    const artifactStorage = {
      status: 'available' as const,
      artifact: {
        kind: 'diagnostic_bundle',
        uri: `s3://sec-review/runs/${queuedId}/artifacts/diagnostic-tree.v1.tar.zst`,
        media_type: 'application/zstd',
        digest: `sha256:${'a'.repeat(64)}`,
        size_bytes: 123
      }
    }
    await store.recordArtifactStorage(queuedId, artifactStorage)
    await store.create_preparing_review_run({
      workflow: 'issue-review',
      run_id: `run-${randomUUID()}`,
      publish_context: {}
    })
    const queued = await store.getRun(queuedId)
    assert.equal(queued?.status, 'queued')
    assert.deepEqual(queued?.artifact_storage, artifactStorage)
    assert.deepEqual(
      (await store.listActiveRuns()).map((run) => run.run_id),
      [queuedId]
    )
  } finally {
    await store.close()
  }
})

test('ReviewRunStore terminates preparation after its claim expires', async () => {
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = `run-stale-preparation-${randomUUID()}`
  try {
    await store.create_preparing_review_run({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })

    assert.equal(await store.expireStalePreparations(), 1)
    const run = await store.getRun(runId)
    assert.equal(run?.status, 'failed')
    assert.equal(run?.failure_code, 'PREPARATION_INTERRUPTED')
    assert.equal(await store.claimPublication(runId), null)
    assert.equal(await store.expireStalePreparations(), 0)
  } finally {
    await store.close()
  }
})

test('ReviewRunStore renews only the current preparation owner', async () => {
  const store = await createStore({ claimTimeoutMs: 1_000 })
  const runId = `run-renewed-preparation-${randomUUID()}`
  const observer = new Pool({ connectionString: requireTestDatabase() })
  try {
    assert.equal(store.preparationHeartbeatIntervalMs(), 333)
    const admission = await store.create_preparing_review_run({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await observer.query(
      `UPDATE review_runs SET preparation_claimed_at=clock_timestamp()-interval '1 hour'
       WHERE run_id=$1`,
      [runId]
    )

    assert.equal(await store.renewPreparationClaim(runId, admission.preparation_token), true)
    assert.equal(await store.renewPreparationClaim(runId, randomUUID()), false)
    assert.equal(await store.expireStalePreparations(), 0)

    await observer.query(
      `UPDATE review_runs SET preparation_claimed_at=clock_timestamp()-interval '1 hour'
       WHERE run_id=$1`,
      [runId]
    )
    assert.equal(await store.expireStalePreparations(), 1)
  } finally {
    await observer.end()
    await store.close()
  }
})

test('ReviewRunStore keeps an admitted run queryable after preparation fails', async () => {
  const store = await createStore()
  const runId = `run-preparation-failed-${randomUUID()}`
  const ingressKey = `delivery-${randomUUID()}`
  try {
    const admission = await store.admit_review_run({
      workflow: 'pull-request-review',
      run_id: runId,
      publish_context: {},
      ingress_kind: 'github_webhook',
      ingress_key: ingressKey
    })
    assert.ok(admission.preparation_token)

    // Input preparation happens after durable admission. Its failure must keep
    // the original run and ingress identity available for diagnosis/replay.
    await store.failPreparation(runId, admission.preparation_token, {
      code: 'REVIEW_START_FAILED',
      message: 'input bundle upload failed'
    })

    const failed = await store.getRun(runId)
    assert.equal(failed?.status, 'failed')
    assert.equal(failed?.ingress_kind, 'github_webhook')
    assert.equal(failed?.ingress_key, ingressKey)
    assert.equal(failed?.failure_code, 'REVIEW_START_FAILED')
    assert.equal(failed?.failure_message, 'input bundle upload failed')
    assert.deepEqual(await store.listActiveRuns(), [])
    assert.equal(await store.claimPublication(runId), null)

    const replay = await store.admit_review_run({
      workflow: 'pull-request-review',
      run_id: `run-replay-${randomUUID()}`,
      publish_context: {},
      ingress_kind: 'github_webhook',
      ingress_key: ingressKey
    })
    assert.equal(replay.created, false)
    assert.equal(replay.record.run_id, runId)
  } finally {
    await store.close()
  }
})

test('ReviewRunStore records one immutable schema version across concurrent initialization', async () => {
  const first = new ReviewRunStore({
    connectionString: requireTestDatabase(),
    connectorId: connectorId()
  })
  const second = new ReviewRunStore({
    connectionString: requireTestDatabase(),
    connectorId: connectorId()
  })
  try {
    await Promise.all([first.initialize(), second.initialize()])
    const observer = new Pool({ connectionString: requireTestDatabase() })
    const versions = (
      await observer.query<{ version: number; name: string; checksum: string }>(
        'SELECT version,name,checksum FROM schema_versions ORDER BY version'
      )
    ).rows
    await observer.end()
    assert.deepEqual(
      versions.map((item) => [item.version, item.name]),
      [[1, 'initial_coordination_schema']]
    )
    for (const version of versions) assert.match(version.checksum, /^[a-f0-9]{64}$/)
  } finally {
    await Promise.all([first.close(), second.close()])
  }
})

test('ReviewRunStore initialization does not steal another replica preparation', async () => {
  const sharedConnector = connectorId()
  const runId = `run-${randomUUID()}`
  const first = await createStore({ connectorId: sharedConnector })
  await first.create_preparing_review_run({
    workflow: 'issue-review',
    run_id: runId,
    publish_context: {}
  })
  await first.close()

  const restarted = await createStore({ connectorId: sharedConnector })
  try {
    const record = await restarted.getRun(runId)
    assert.equal(record?.status, 'preparing')
    assert.equal(record?.failure_code, null)
  } finally {
    await restarted.close()
  }
})

test('ReviewRunStore atomically deduplicates concurrent ingress across connections', async () => {
  const sharedConnector = connectorId()
  const first = await createStore({ connectorId: sharedConnector })
  const second = await createStore({ connectorId: sharedConnector })
  const ingress = {
    workflow: 'issue-review' as const,
    publish_context: {},
    ingress_kind: 'github_webhook' as const,
    ingress_key: `delivery-${randomUUID()}`
  }
  try {
    const admissions = await Promise.all([
      first.admit_review_run({ ...ingress, run_id: `run-${randomUUID()}` }),
      second.admit_review_run({ ...ingress, run_id: `run-${randomUUID()}` })
    ])
    assert.equal(admissions.filter((item) => item.created).length, 1)
    assert.equal(new Set(admissions.map((item) => item.record.run_id)).size, 1)
  } finally {
    await Promise.all([first.close(), second.close()])
  }
})

test('ReviewRunStore fences a stale preparation owner after ingress takeover', async () => {
  const sharedConnector = connectorId()
  const ownerA = await createStore({ connectorId: sharedConnector, claimTimeoutMs: 0 })
  const ownerB = await createStore({ connectorId: sharedConnector, claimTimeoutMs: 0 })
  const ingress = {
    workflow: 'issue-review' as const,
    publish_context: {},
    ingress_kind: 'github_webhook' as const,
    ingress_key: `delivery-${randomUUID()}`
  }
  try {
    const first = await ownerA.admit_review_run({ ...ingress, run_id: `run-${randomUUID()}` })
    const takeover = await ownerB.admit_review_run({ ...ingress, run_id: `run-${randomUUID()}` })
    assert.ok(first.preparation_token)
    assert.ok(takeover.preparation_token)
    assert.equal(takeover.record.run_id, first.record.run_id)
    assert.notEqual(takeover.preparation_token, first.preparation_token)

    await assert.rejects(
      ownerA.save_prepared_submission(first.record.run_id, first.preparation_token, {}, {}),
      /cannot save prepared submission/
    )
    await assert.rejects(
      ownerA.mark_queued(first.record.run_id, first.preparation_token, {}),
      /cannot transition/
    )
    await assert.rejects(
      ownerA.failPreparation(first.record.run_id, first.preparation_token, {
        message: 'late failure'
      }),
      /claim was lost/
    )
    await ownerB.mark_queued(takeover.record.run_id, takeover.preparation_token, {})
    assert.equal((await ownerA.getRun(first.record.run_id))?.status, 'queued')
  } finally {
    await Promise.all([ownerA.close(), ownerB.close()])
  }
})

test('ReviewRunStore recovers an uncertain submission with a fenced claim', async () => {
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = `run-${randomUUID()}`
  try {
    const admission = await store.create_preparing_review_run({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await store.save_prepared_submission(
      runId,
      admission.preparation_token,
      {},
      { contract_version: 'v5' }
    )
    await store.failPreparation(runId, admission.preparation_token, {
      code: 'SUBMISSION_STATE_UNCERTAIN',
      message: 'response lost'
    })
    const staleToken = await store.claimSubmissionRecovery(runId)
    const currentToken = await store.claimSubmissionRecovery(runId)
    assert.ok(staleToken)
    assert.ok(currentToken)
    assert.notEqual(staleToken, currentToken)
    assert.equal(await store.completeSubmissionRecovery(runId, staleToken), false)
    assert.equal(await store.completeSubmissionRecovery(runId, currentToken), true)
    assert.equal((await store.getRun(runId))?.status, 'queued')
    assert.equal(
      (await store.listActiveRuns()).some((run) => run.run_id === runId),
      true
    )
  } finally {
    await store.close()
  }
})

test('ReviewRunStore fences a stale publisher after another connection takes over', async () => {
  const sharedConnector = connectorId()
  const ownerA = await createStore({ connectorId: sharedConnector, claimTimeoutMs: 0 })
  const ownerB = await createStore({ connectorId: sharedConnector, claimTimeoutMs: 0 })
  const runId = await createSuccessfulRun(ownerA)
  try {
    const staleToken = await ownerA.claimPublication(runId)
    const currentToken = await ownerB.claimPublication(runId)
    assert.ok(staleToken)
    assert.ok(currentToken)
    assert.notEqual(staleToken, currentToken)
    assert.equal(await ownerA.completePublication(runId, staleToken), false)
    assert.equal(
      await ownerA.failPublication(runId, staleToken, { message: 'late failure' }, { retry: true }),
      false
    )
    assert.equal(await ownerB.completePublication(runId, currentToken), true)
    const record = await ownerA.getRun(runId)
    assert.equal(record?.status, 'published')
  } finally {
    await Promise.all([ownerA.close(), ownerB.close()])
  }
})

test('ReviewRunStore does not publish while a required step is incomplete', async () => {
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const token = await store.claimPublication(runId)
    assert.ok(token)
    await store.initializePublicationSteps(runId, token, ['issue:summary-comment'])
    const [step] = await store.listPublicationSteps(runId)
    assert.equal(step?.failure_count, 0)
    assert.equal(await store.completePublication(runId, token), false)
    assert.equal((await store.getRun(runId))?.status, 'publishing')
  } finally {
    await store.close()
  }
})

test('ReviewRunStore spends retry budget only for the current publication owner', async () => {
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const token = await store.claimPublication(runId)
    assert.ok(token)
    assert.equal(
      await store.failPublication(
        runId,
        token,
        { code: 'HTTP_503', message: 'unavailable' },
        { retry: true }
      ),
      true
    )
    const record = await store.getRun(runId)
    assert.equal(record?.status, 'succeeded')
    assert.deepEqual(await store.listActiveRuns(), [])
  } finally {
    await store.close()
  }
})

test('ReviewRunStore fences publication step commits with the current publication token', async () => {
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = await createSuccessfulRun(store)
  try {
    const staleToken = await store.claimPublication(runId)
    assert.ok(staleToken)
    await store.initializePublicationSteps(runId, staleToken, ['repository:summary-issue'])
    await store.requirePublicationStepClaim(runId, staleToken, 'repository:summary-issue')

    const currentToken = await store.claimPublication(runId)
    assert.ok(currentToken)
    assert.equal(
      await store.completePublicationStep(runId, staleToken, 'repository:summary-issue', { id: 7 }),
      false
    )
    assert.equal(
      await store.failPublicationStep(runId, staleToken, 'repository:summary-issue', {
        message: 'late failure'
      }),
      false
    )
  } finally {
    await store.close()
  }
})

test('ReviewRunStore reports an exhausted publication step as deterministic', async () => {
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = await store.claimPublication(runId)
      assert.ok(token)
      if (attempt === 0)
        await store.initializePublicationSteps(runId, token, ['issue:summary-comment'])
      await store.requirePublicationStepClaim(runId, token, 'issue:summary-comment')
      assert.equal(
        await store.failPublicationStep(runId, token, 'issue:summary-comment', {
          message: 'temporary failure'
        }),
        true
      )
      assert.equal((await store.listPublicationSteps(runId))[0]?.failure_count, attempt + 1)
      assert.equal(
        await store.failPublication(
          runId,
          token,
          { message: 'temporary failure' },
          { retry: true }
        ),
        true
      )
    }

    const finalToken = await store.claimPublication(runId)
    assert.ok(finalToken)
    await assert.rejects(
      store.requirePublicationStepClaim(runId, finalToken, 'issue:summary-comment'),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PUBLICATION_STEP_RETRY_EXHAUSTED'
    )
    const [step] = await store.listPublicationSteps(runId)
    assert.equal(step?.status, 'terminal_failed')
    assert.equal(step?.failure_count, 3)
  } finally {
    await store.close()
  }
})

test('ReviewRunStore records Runner execution failure without publication failure', async () => {
  const store = await createStore()
  const runId = await createQueuedRun(store)
  try {
    assert.equal(
      await store.failRunnerExecution(runId, {
        code: 'RUNNER_EXECUTION_FAILED',
        message: 'Agent execution failed.'
      }),
      true
    )
    const record = await store.getRun(runId)
    assert.equal(record?.status, 'failed')
    assert.equal(record?.failure_code, 'RUNNER_EXECUTION_FAILED')
    assert.equal(await store.claimPublication(runId), null)
  } finally {
    await store.close()
  }
})

test('ReviewRunStore renews a publication claim before another owner can take it', async () => {
  const sharedConnector = connectorId()
  const ownerA = await createStore({ connectorId: sharedConnector, claimTimeoutMs: 1_000 })
  const ownerB = await createStore({ connectorId: sharedConnector, claimTimeoutMs: 1_000 })
  const runId = await createSuccessfulRun(ownerA)
  const observer = new Pool({ connectionString: requireTestDatabase() })
  try {
    const token = await ownerA.claimPublication(runId)
    assert.ok(token)
    await observer.query(
      "UPDATE publications SET claimed_at=clock_timestamp()-interval '2 seconds' WHERE run_id=$1 AND connector_id=$2",
      [runId, sharedConnector]
    )
    assert.equal(await ownerA.renewPublicationClaim(runId, token), true)
    assert.equal(await ownerB.claimPublication(runId), null)
  } finally {
    await observer.end()
    await Promise.all([ownerA.close(), ownerB.close()])
  }
})
