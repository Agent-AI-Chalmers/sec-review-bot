// Exercises the PostgreSQL-backed coordination state machines, including their
// claim fencing and cross-connector ownership rules.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'

import { ReviewRunStore, type RunnerArtifactStorage } from '../../src/index.js'

const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

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
    ...(options.claimTimeoutMs === undefined
      ? {}
      : { claimTimeoutMs: options.claimTimeoutMs })
  })
  await store.initialize()
  return store
}

async function createQueuedRun(
  store: ReviewRunStore,
  runId = `run-${randomUUID()}`
): Promise<string> {
  const context = {}
  const admission = await store.createPreparingReviewRun({
    workflow: 'issue-review',
    run_id: runId,
    publish_context: context
  })
  assert.ok(admission.preparation_token)
  await store.markQueued(runId, admission.preparation_token, context)
  return runId
}

async function createSuccessfulRun(
  store: ReviewRunStore,
  runId = `run-${randomUUID()}`
): Promise<string> {
  await createQueuedRun(store, runId)
  assert.strictEqual(
    await store.recordRunnerSuccess(
      runId,
      { run_id: runId },
      { status: 'unavailable' }
    ),
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

    assert.strictEqual((await first.getRun(runId))?.run_id, runId)
    // run_id is currently a global primary key, while connector_id fences
    // reads and claims. A second connector must not create or see the first
    // connector's run under that identity.
    await assert.rejects(
      createQueuedRun(second, runId),
      /duplicate key value violates unique constraint/
    )
    assert.strictEqual(await second.getRun(runId), null)
    assert.strictEqual((await first.listActiveRuns()).runs.length, 1)
    assert.strictEqual((await second.listActiveRuns()).runs.length, 0)
    assert.strictEqual(await first.claimPublication(runId), null)
    await first.recordRunnerSuccess(
      runId,
      { run_id: runId },
      { status: 'unavailable' }
    )
    assert.notStrictEqual(await first.claimPublication(runId), null)
    assert.strictEqual(await second.claimPublication(runId), null)
  } finally {
    await first.close()
    await second.close()
  }
})

test('ReviewRunStore persists queued runs and keeps preparing runs out of polling', async () => {
  const store = await createStore()
  try {
    const queuedId = await createQueuedRun(store)
    const artifactStorage: RunnerArtifactStorage = {
      status: 'available',
      artifact: {
        kind: 'diagnostic_bundle',
        uri: `s3://sec-review/runs/${queuedId}/artifacts/diagnostic-tree.v1.tar.zst`,
        media_type: 'application/tar+zstd',
        digest: `sha256:${'a'.repeat(64)}`,
        size_bytes: 123
      }
    }
    await store.recordArtifactStorage(queuedId, artifactStorage)
    await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: `run-${randomUUID()}`,
      publish_context: {}
    })
    const queued = await store.getRun(queuedId)
    assert.strictEqual(queued?.runner_status, 'queued')
    assert.deepStrictEqual(queued?.artifact_storage, artifactStorage)
    assert.deepStrictEqual(
      (await store.listActiveRuns()).runs.map((entry) => entry.run_id),
      [queuedId]
    )
  } finally {
    await store.close()
  }
})

test('ReviewRunStore returns an expired preparation to pending without failing its run', async () => {
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = `run-stale-preparation-${randomUUID()}`
  try {
    await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })

    assert.strictEqual(await store.expireStalePreparations(), 1)
    const run = await store.getRun(runId)
    assert.strictEqual(run?.runner_status, 'preparing')
    assert.strictEqual(run?.failure_code, null)
    assert.strictEqual(await store.claimPublication(runId), null)
    assert.strictEqual(await store.expireStalePreparations(), 0)
  } finally {
    await store.close()
  }
})

test('ReviewRunStore exhausts a preparation whose final claim lease expires', async () => {
  const store = await createStore({ claimTimeoutMs: 0 })
  const observer = new Pool({ connectionString: requireTestDatabase() })
  const runId = `run-exhausted-preparation-${randomUUID()}`
  try {
    await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    await observer.query(
      `UPDATE preparations SET attempt_count=8,
        claimed_at=clock_timestamp()-interval '1 hour' WHERE run_id=$1`,
      [runId]
    )
    assert.strictEqual(await store.expireStalePreparations(), 1)
    const run = await store.getRun(runId)
    assert.strictEqual(run?.runner_status, 'failed')
    assert.strictEqual(run?.failure_code, 'PREPARATION_RETRY_EXHAUSTED')
    assert.strictEqual(await store.claimNextPreparation(), null)
    assert.strictEqual(await store.claimPublication(runId), null)
    const notice = await store.claimNextPreparationFailureNotice()
    assert.ok(notice)
    assert.strictEqual(notice.run_id, runId)
    assert.deepStrictEqual(notice.input, {})
    assert.strictEqual(notice.failure_code, 'PREPARATION_RETRY_EXHAUSTED')
    assert.strictEqual(
      await store.completePreparationFailureNotice(runId, randomUUID(), true),
      false
    )
    assert.strictEqual(
      await store.completePreparationFailureNotice(
        runId,
        notice.claim_token,
        true
      ),
      true
    )
    assert.strictEqual(await store.claimNextPreparationFailureNotice(), null)
  } finally {
    await observer.end()
    await store.close()
  }
})

test('ReviewRunStore claims an expired preparation from its durable connector input', async () => {
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = `run-claimable-preparation-${randomUUID()}`
  try {
    const admission = await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {},
      preparation_input_version: 'v1',
      preparation_input: { kind: 'connector_issue_review', issue_number: 12 }
    })
    assert.ok(admission.preparation_token)
    await store.checkpointPreparationInput(runId, admission.preparation_token, {
      kind: 'connector_issue_review',
      issue_number: 12,
      resolved: true
    })
    assert.strictEqual(await store.expireStalePreparations(), 1)

    const claimed = await store.claimNextPreparation()
    assert.ok(claimed)
    const token = claimed.claim_token
    assert.deepStrictEqual(claimed, {
      run_id: runId,
      workflow: 'issue-review',
      input_version: 'v1',
      input: {
        kind: 'connector_issue_review',
        issue_number: 12,
        resolved: true
      },
      claim_token: token,
      attempt_count: 2
    })
    assert.notStrictEqual(token, admission.preparation_token)
    assert.strictEqual(
      await store.renewPreparationClaim(runId, admission.preparation_token),
      false
    )
    assert.strictEqual(await store.renewPreparationClaim(runId, token), true)
  } finally {
    await store.close()
  }
})

test('ReviewRunStore does not let ingress replay bypass preparation backoff', async () => {
  const store = await createStore()
  const runId = `run-preparation-backoff-${randomUUID()}`
  try {
    const admission = await store.admitReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {},
      ingress_kind: 'github_webhook',
      ingress_key: `delivery-${runId}`,
      preparation_input_version: 'v1',
      preparation_input: { kind: 'test' }
    })
    assert.ok(admission.preparation_token)
    assert.deepStrictEqual(
      await store.failPreparation(
        runId,
        admission.preparation_token,
        { message: 'temporary' },
        { retry: true, retryAfterMs: 60_000 }
      ),
      { retry_scheduled: true }
    )
    const replay = await store.admitReviewRun({
      workflow: 'issue-review',
      run_id: `other-${runId}`,
      publish_context: {},
      ingress_kind: 'github_webhook',
      ingress_key: `delivery-${runId}`,
      preparation_input_version: 'v1',
      preparation_input: { kind: 'test' }
    })
    assert.strictEqual(replay.created, false)
    assert.strictEqual(replay.preparation_token, null)
    assert.strictEqual(await store.claimNextPreparation(), null)
  } finally {
    await store.close()
  }
})

test('ReviewRunStore renews only the current preparation owner', async () => {
  const store = await createStore({ claimTimeoutMs: 1_000 })
  const runId = `run-renewed-preparation-${randomUUID()}`
  const observer = new Pool({ connectionString: requireTestDatabase() })
  try {
    assert.strictEqual(store.preparationHeartbeatIntervalMs(), 333)
    const admission = await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await observer.query(
      `UPDATE preparations SET claimed_at=clock_timestamp()-interval '1 hour'
       WHERE run_id=$1`,
      [runId]
    )

    assert.strictEqual(
      await store.renewPreparationClaim(runId, admission.preparation_token),
      true
    )
    assert.strictEqual(
      await store.renewPreparationClaim(runId, randomUUID()),
      false
    )
    assert.strictEqual(await store.expireStalePreparations(), 0)

    await observer.query(
      `UPDATE preparations SET claimed_at=clock_timestamp()-interval '1 hour'
       WHERE run_id=$1`,
      [runId]
    )
    assert.strictEqual(await store.expireStalePreparations(), 1)
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
    const admission = await store.admitReviewRun({
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
    assert.strictEqual(failed?.runner_status, 'failed')
    assert.strictEqual(failed?.ingress_kind, 'github_webhook')
    assert.strictEqual(failed?.ingress_key, ingressKey)
    assert.strictEqual(failed?.failure_code, 'REVIEW_START_FAILED')
    assert.strictEqual(failed?.failure_message, 'input bundle upload failed')
    assert.deepStrictEqual((await store.listActiveRuns()).runs, [])
    assert.strictEqual(await store.claimPublication(runId), null)

    const replay = await store.admitReviewRun({
      workflow: 'pull-request-review',
      run_id: `run-replay-${randomUUID()}`,
      publish_context: {},
      ingress_kind: 'github_webhook',
      ingress_key: ingressKey
    })
    assert.strictEqual(replay.created, false)
    assert.strictEqual(replay.record.run_id, runId)
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
    assert.deepStrictEqual(
      versions.map((item) => [item.version, item.name]),
      [[1, 'initial_coordination_schema']]
    )
    for (const version of versions)
      assert.match(version.checksum, /^[a-f0-9]{64}$/)
  } finally {
    await Promise.all([first.close(), second.close()])
  }
})

test('ReviewRunStore initialization does not steal another replica preparation', async () => {
  const sharedConnector = connectorId()
  const runId = `run-${randomUUID()}`
  const first = await createStore({ connectorId: sharedConnector })
  await first.createPreparingReviewRun({
    workflow: 'issue-review',
    run_id: runId,
    publish_context: {}
  })
  await first.close()

  const restarted = await createStore({ connectorId: sharedConnector })
  try {
    const record = await restarted.getRun(runId)
    assert.strictEqual(record?.runner_status, 'preparing')
    assert.strictEqual(record?.failure_code, null)
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
      first.admitReviewRun({ ...ingress, run_id: `run-${randomUUID()}` }),
      second.admitReviewRun({ ...ingress, run_id: `run-${randomUUID()}` })
    ])
    assert.strictEqual(admissions.filter((item) => item.created).length, 1)
    assert.strictEqual(
      new Set(admissions.map((item) => item.record.run_id)).size,
      1
    )
  } finally {
    await Promise.all([first.close(), second.close()])
  }
})

test('ReviewRunStore leaves ingress replay read-only and lets the coordinator take over preparation', async () => {
  const sharedConnector = connectorId()
  const ownerA = await createStore({
    connectorId: sharedConnector,
    claimTimeoutMs: 0
  })
  const ownerB = await createStore({
    connectorId: sharedConnector,
    claimTimeoutMs: 0
  })
  const ingress = {
    workflow: 'issue-review' as const,
    publish_context: {},
    ingress_kind: 'github_webhook' as const,
    ingress_key: `delivery-${randomUUID()}`
  }
  try {
    const first = await ownerA.admitReviewRun({
      ...ingress,
      run_id: `run-${randomUUID()}`
    })
    const replay = await ownerB.admitReviewRun({
      ...ingress,
      run_id: `run-${randomUUID()}`
    })
    assert.ok(first.preparation_token)
    assert.strictEqual(replay.created, false)
    assert.strictEqual(replay.preparation_token, null)
    assert.strictEqual(replay.record.run_id, first.record.run_id)

    assert.strictEqual(await ownerB.expireStalePreparations(), 1)
    const takeover = await ownerB.claimNextPreparation()
    assert.ok(takeover)
    assert.strictEqual(takeover.run_id, first.record.run_id)
    assert.notStrictEqual(takeover.claim_token, first.preparation_token)

    await assert.rejects(
      ownerA.checkpointPreparationInput(
        first.record.run_id,
        first.preparation_token,
        { stale: true }
      ),
      /claim was lost before checkpointing input/
    )
    await assert.rejects(
      ownerA.savePreparedSubmission(
        first.record.run_id,
        first.preparation_token,
        {},
        {}
      ),
      /cannot save prepared submission/
    )
    await assert.rejects(
      ownerA.markQueued(first.record.run_id, first.preparation_token, {}),
      /cannot transition/
    )
    await assert.rejects(
      ownerA.failPreparation(first.record.run_id, first.preparation_token, {
        message: 'late failure'
      }),
      /claim was lost/
    )
    await ownerB.markQueued(takeover.run_id, takeover.claim_token, {})
    assert.strictEqual(
      (await ownerA.getRun(first.record.run_id))?.runner_status,
      'queued'
    )
  } finally {
    await Promise.all([ownerA.close(), ownerB.close()])
  }
})

test('ReviewRunStore recovers an uncertain submission with a fenced claim', async () => {
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = `run-${randomUUID()}`
  try {
    const admission = await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await store.savePreparedSubmission(
      runId,
      admission.preparation_token,
      {},
      { contract_version: 'v6' }
    )
    await store.failPreparation(runId, admission.preparation_token, {
      code: 'SUBMISSION_STATE_UNCERTAIN',
      message: 'response lost'
    })
    const staleToken = await store.claimSubmissionRecovery(runId)
    const currentToken = await store.claimSubmissionRecovery(runId)
    assert.ok(staleToken)
    assert.ok(currentToken)
    assert.notStrictEqual(staleToken, currentToken)
    assert.strictEqual(
      await store.completeSubmissionRecovery(runId, staleToken),
      false
    )
    assert.strictEqual(
      await store.completeSubmissionRecovery(runId, currentToken),
      true
    )
    assert.strictEqual((await store.getRun(runId))?.runner_status, 'queued')
    assert.strictEqual(
      (await store.listActiveRuns()).runs.some(
        (entry) => entry.run_id === runId
      ),
      true
    )
  } finally {
    await store.close()
  }
})

test('ReviewRunStore fences a stale publisher after another connection takes over', async () => {
  const sharedConnector = connectorId()
  const ownerA = await createStore({
    connectorId: sharedConnector,
    claimTimeoutMs: 0
  })
  const ownerB = await createStore({
    connectorId: sharedConnector,
    claimTimeoutMs: 0
  })
  const runId = await createSuccessfulRun(ownerA)
  try {
    const staleToken = await ownerA.claimPublication(runId)
    const currentToken = await ownerB.claimPublication(runId)
    assert.ok(staleToken)
    assert.ok(currentToken)
    assert.notStrictEqual(staleToken, currentToken)
    assert.strictEqual(
      await ownerA.completePublication(runId, staleToken),
      false
    )
    assert.strictEqual(
      await ownerA.failPublication(
        runId,
        staleToken,
        { message: 'late failure' },
        { retry: true }
      ),
      false
    )
    assert.strictEqual(
      await ownerB.completePublication(runId, currentToken),
      true
    )
    const record = await ownerA.getRun(runId)
    assert.strictEqual(record?.publication_status, 'published')
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
    await store.initializePublicationSteps(runId, token, [
      'issue:summary-comment'
    ])
    const [step] = await store.listPublicationSteps(runId)
    assert.strictEqual(step?.failure_count, 0)
    assert.strictEqual(await store.completePublication(runId, token), false)
    assert.strictEqual(
      (await store.getRun(runId))?.publication_status,
      'publishing'
    )
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
    assert.strictEqual(
      await store.failPublication(
        runId,
        token,
        { code: 'HTTP_503', message: 'unavailable' },
        { retry: true }
      ),
      true
    )
    const record = await store.getRun(runId)
    assert.strictEqual(record?.runner_status, 'succeeded')
    assert.deepStrictEqual((await store.listActiveRuns()).runs, [])
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
    await store.initializePublicationSteps(runId, staleToken, [
      'repository:summary-issue'
    ])
    await store.requirePublicationStepClaim(
      runId,
      staleToken,
      'repository:summary-issue'
    )

    const currentToken = await store.claimPublication(runId)
    assert.ok(currentToken)
    assert.strictEqual(
      await store.completePublicationStep(
        runId,
        staleToken,
        'repository:summary-issue',
        {
          id: '7'
        }
      ),
      false
    )
    assert.strictEqual(
      await store.failPublicationStep(
        runId,
        staleToken,
        'repository:summary-issue',
        {
          message: 'late failure'
        }
      ),
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
        await store.initializePublicationSteps(runId, token, [
          'issue:summary-comment'
        ])
      await store.requirePublicationStepClaim(
        runId,
        token,
        'issue:summary-comment'
      )
      assert.strictEqual(
        await store.failPublicationStep(runId, token, 'issue:summary-comment', {
          message: 'temporary failure'
        }),
        true
      )
      assert.strictEqual(
        (await store.listPublicationSteps(runId))[0]?.failure_count,
        attempt + 1
      )
      assert.strictEqual(
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
      store.requirePublicationStepClaim(
        runId,
        finalToken,
        'issue:summary-comment'
      ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PUBLICATION_STEP_RETRY_EXHAUSTED'
    )
    const [step] = await store.listPublicationSteps(runId)
    assert.strictEqual(step?.status, 'terminal_failed')
    assert.strictEqual(step?.failure_count, 3)
  } finally {
    await store.close()
  }
})

test('ReviewRunStore records Runner execution failure without publication failure', async () => {
  const store = await createStore()
  const runId = await createQueuedRun(store)
  try {
    assert.strictEqual(
      await store.failRunnerExecution(runId, {
        code: 'RUNNER_EXECUTION_FAILED',
        message: 'Agent execution failed.'
      }),
      true
    )
    const record = await store.getRun(runId)
    assert.strictEqual(record?.runner_status, 'failed')
    assert.strictEqual(record?.failure_code, 'RUNNER_EXECUTION_FAILED')
    assert.strictEqual(await store.claimPublication(runId), null)
  } finally {
    await store.close()
  }
})

test('ReviewRunStore renews a publication claim before another owner can take it', async () => {
  const sharedConnector = connectorId()
  const ownerA = await createStore({
    connectorId: sharedConnector,
    claimTimeoutMs: 1_000
  })
  const ownerB = await createStore({
    connectorId: sharedConnector,
    claimTimeoutMs: 1_000
  })
  const runId = await createSuccessfulRun(ownerA)
  const observer = new Pool({ connectionString: requireTestDatabase() })
  try {
    const token = await ownerA.claimPublication(runId)
    assert.ok(token)
    await observer.query(
      "UPDATE publications SET claimed_at=clock_timestamp()-interval '2 seconds' WHERE run_id=$1 AND connector_id=$2",
      [runId, sharedConnector]
    )
    assert.strictEqual(await ownerA.renewPublicationClaim(runId, token), true)
    assert.strictEqual(await ownerB.claimPublication(runId), null)
  } finally {
    await observer.end()
    await Promise.all([ownerA.close(), ownerB.close()])
  }
})

test('ReviewRunStore accepts an identical publication step set under a case-insensitive collation', async () => {
  // Regression guard for the #96 wedge. Persisted step keys come back in the
  // database collation order (`en_US.utf8` orders `case-7` before
  // `CVE-2024-1008`, while JavaScript sorts by UTF-16 code unit). Comparing the
  // two raw orders made the second call with an identical key set throw
  // 'Publication step set changed', and the publication could never leave
  // 'pending'.
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  const stepKeys = [
    'repository:delivery:CVE-2024-1008',
    'repository:delivery:case-7',
    'repository:summary-issue'
  ]
  try {
    const firstToken = await store.claimPublication(runId)
    assert.ok(firstToken)
    await store.initializePublicationSteps(runId, firstToken, stepKeys)
    assert.strictEqual(
      await store.failPublication(
        runId,
        firstToken,
        { message: 'temporary failure' },
        { retry: true }
      ),
      true
    )

    const secondToken = await store.claimPublication(runId)
    assert.ok(secondToken)
    await store.initializePublicationSteps(runId, secondToken, stepKeys)

    const persisted = (await store.listPublicationSteps(runId)).map(
      (step) => step.step_key
    )
    assert.deepStrictEqual(persisted.sort(), [...stepKeys].sort())
  } finally {
    await store.close()
  }
})

test('ReviewRunStore reports a duplicate publication step set as deterministic', async () => {
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const token = await store.claimPublication(runId)
    assert.ok(token)
    await assert.rejects(
      store.initializePublicationSteps(runId, token, [
        'repository:summary-issue',
        'repository:summary-issue'
      ]),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PUBLICATION_STEP_SET_DUPLICATE'
    )
  } finally {
    await store.close()
  }
})

test('ReviewRunStore reports a changed publication step set as deterministic', async () => {
  // A stored run's step set is fixed, so a genuine change can never be repaired
  // by re-claiming the publication; it must reach a terminal state instead.
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const firstToken = await store.claimPublication(runId)
    assert.ok(firstToken)
    await store.initializePublicationSteps(runId, firstToken, [
      'repository:summary-issue'
    ])
    assert.strictEqual(
      await store.failPublication(
        runId,
        firstToken,
        { message: 'temporary failure' },
        { retry: true }
      ),
      true
    )

    const secondToken = await store.claimPublication(runId)
    assert.ok(secondToken)
    await assert.rejects(
      store.initializePublicationSteps(runId, secondToken, [
        'repository:summary-issue',
        'repository:summary-comment'
      ]),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PUBLICATION_STEP_SET_CHANGED'
    )
  } finally {
    await store.close()
  }
})

test('claimNextPublication returns the persisted result, context, and artifact', async () => {
  // `claimNextPublication` hands the publisher everything it needs to publish: the Runner's
  // opaque result, the publish context, and the artifact reference, alongside the claim
  // token. `claimPublication` (covered above) only returns a token, so this is the shape a
  // publisher actually receives and must match what was persisted.
  const store = await createStore()
  const runId = `run-${randomUUID()}`
  const context = { repository: 'octo/example' }
  const admission = await store.createPreparingReviewRun({
    workflow: 'issue-review',
    run_id: runId,
    publish_context: context
  })
  assert.ok(admission.preparation_token)
  await store.markQueued(runId, admission.preparation_token, context)
  const workflowResult = {
    run_id: runId,
    review_record: { analysis: { verdict: 'no-findings' } }
  }
  assert.strictEqual(
    await store.recordRunnerSuccess(runId, workflowResult, {
      status: 'unavailable'
    }),
    true
  )
  try {
    const work = await store.claimNextPublication()
    assert.strictEqual(work?.run_id, runId)
    assert.strictEqual(work?.claim_token.length, 36)
    assert.deepStrictEqual(work?.artifact_storage, { status: 'unavailable' })
    assert.deepStrictEqual(work?.workflow_result, workflowResult)
    assert.deepStrictEqual(work?.publish_context, context)
  } finally {
    await store.close()
  }
})

test('concurrent claimNextPublication consumers cannot own the same ready run', async () => {
  // Two publishers polling the same connector must not both claim the ready run: the claim is
  // `FOR UPDATE ... SKIP LOCKED`, so one wins and the other finds nothing. Asserting this with
  // real concurrent connections (rather than sequential calls) is what exercises the lock.
  const connectorId = `publisher:${randomUUID()}`
  const first = await createStore({ connectorId })
  const second = await createStore({ connectorId })
  try {
    await createSuccessfulRun(first)
    const claims = await Promise.all([
      first.claimNextPublication(),
      second.claimNextPublication()
    ])
    assert.strictEqual(claims.filter((claim) => claim !== null).length, 1)
  } finally {
    await first.close()
    await second.close()
  }
})

test('a retryable publication failure makes the run claimable again', async () => {
  // The counterpart to `spends retry budget only for the current publication owner`, which
  // asserts the retryable failure is accepted: this asserts the run becomes claimable again
  // afterwards, so the retry the budget allowed actually happens.
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const work = await store.claimNextPublication()
    assert.ok(work)
    assert.strictEqual(
      await store.failPublication(
        runId,
        work.claim_token,
        { message: 'GitHub unavailable' },
        { retry: true }
      ),
      true
    )
    assert.strictEqual((await store.claimNextPublication())?.run_id, runId)
  } finally {
    await store.close()
  }
})

test('the write path refuses an artifact storage value the contract forbids', async () => {
  // Every `artifact_storage` write narrows the value through `normalizeArtifactStorage`, so a
  // shape the contract cannot represent (an `available` record without its artifact) is
  // rejected before it is persisted rather than being discovered later by a read. The run id
  // is in the message, so the fault names the record.
  const store = await createStore()
  const runId = await createQueuedRun(store)
  try {
    await assert.rejects(
      store.recordArtifactStorage(runId, { status: 'available' }),
      new RegExp(
        `run ${runId} is an available artifact storage record without its artifact`
      )
    )
    await assert.rejects(
      store.recordRunnerSuccess(
        runId,
        { run_id: runId },
        { status: 'available' }
      ),
      /without its artifact reference/
    )
    await assert.rejects(
      store.failRunnerExecution(
        runId,
        { message: 'failed' },
        { status: 'available' }
      ),
      /without its artifact reference/
    )
    // Nothing was written: the run is still exactly as it was queued.
    assert.strictEqual((await store.getRun(runId))?.artifact_storage, null)
  } finally {
    await store.close()
  }
})
