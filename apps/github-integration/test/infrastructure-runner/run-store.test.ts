import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'

import { ReviewRunStore } from '../../infrastructure/runner/review-store.js'
import { publishContextForWorkflow } from '../publish-context-fixtures.js'

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

function requireTestDatabase (): string {
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL store tests.')
  return connectionString
}

function connectorId (): string { return `test:${randomUUID()}` }

async function createStore (options: { connectorId?: string, claimTimeoutMs?: number } = {}): Promise<ReviewRunStore> {
  const store = new ReviewRunStore({
    connectionString: requireTestDatabase(),
    connectorId: options.connectorId ?? connectorId(),
    ...(options.claimTimeoutMs === undefined ? {} : { claimTimeoutMs: options.claimTimeoutMs })
  })
  await store.initialize()
  return store
}

async function createQueuedRun (store: ReviewRunStore, runId = `run-${randomUUID()}`): Promise<string> {
  const context = publishContextForWorkflow('issue-review')
  const admission = await store.create_preparing_review_run({ workflow: 'issue-review', run_id: runId, publish_context: context })
  assert.ok(admission.preparation_token)
  await store.mark_queued(runId, admission.preparation_token, context)
  return runId
}

test('ReviewRunStore persists queued runs and keeps preparing runs out of polling', async () => {
  const store = await createStore()
  try {
    const queuedId = await createQueuedRun(store)
    await store.create_preparing_review_run({ workflow: 'issue-review', run_id: `run-${randomUUID()}`, publish_context: {} })
    assert.equal((await store.getRun(queuedId))?.status, 'queued')
    assert.deepEqual((await store.listActiveRuns()).map(run => run.run_id), [queuedId])
  } finally { await store.close() }
})

test('ReviewRunStore terminates preparation after its claim expires', async () => {
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = `run-stale-preparation-${randomUUID()}`
  try {
    await store.create_preparing_review_run({ workflow: 'issue-review', run_id: runId, publish_context: {} })

    assert.equal(await store.expireStalePreparations(), 1)
    const run = await store.getRun(runId)
    assert.equal(run?.status, 'failed')
    assert.equal(run?.failure_code, 'PREPARATION_INTERRUPTED')
    assert.equal(await store.claimPublication(runId), null)
    assert.equal(await store.expireStalePreparations(), 0)
  } finally { await store.close() }
})

test('ReviewRunStore records one immutable schema version across concurrent initialization', async () => {
  const first = new ReviewRunStore({ connectionString: requireTestDatabase(), connectorId: connectorId() })
  const second = new ReviewRunStore({ connectionString: requireTestDatabase(), connectorId: connectorId() })
  try {
    await Promise.all([first.initialize(), second.initialize()])
    const observer = new Pool({ connectionString: requireTestDatabase() })
    const versions = (await observer.query<{ version: number, name: string, checksum: string }>(
      'SELECT version,name,checksum FROM schema_versions ORDER BY version'
    )).rows
    await observer.end()
    assert.deepEqual(versions.map(item => [item.version, item.name]), [[1, 'initial_coordination_schema']])
    assert.match(versions[0]?.checksum ?? '', /^[a-f0-9]{64}$/)
  } finally { await Promise.all([first.close(), second.close()]) }
})

test('ReviewRunStore initialization does not steal another replica preparation', async () => {
  const sharedConnector = connectorId()
  const runId = `run-${randomUUID()}`
  const first = await createStore({ connectorId: sharedConnector })
  await first.create_preparing_review_run({ workflow: 'issue-review', run_id: runId, publish_context: {} })
  await first.close()

  const restarted = await createStore({ connectorId: sharedConnector })
  try {
    const record = await restarted.getRun(runId)
    assert.equal(record?.status, 'preparing')
    assert.equal(record?.failure_code, null)
  } finally { await restarted.close() }
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
    assert.equal(admissions.filter(item => item.created).length, 1)
    assert.equal(new Set(admissions.map(item => item.record.run_id)).size, 1)
  } finally { await Promise.all([first.close(), second.close()]) }
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
      ownerA.save_prepared_submission(first.record.run_id, first.preparation_token, publishContextForWorkflow('issue-review'), {}),
      /cannot save prepared submission/
    )
    await assert.rejects(
      ownerA.mark_queued(first.record.run_id, first.preparation_token, publishContextForWorkflow('issue-review')),
      /cannot transition/
    )
    await assert.rejects(
      ownerA.failPreparation(first.record.run_id, first.preparation_token, { message: 'late failure' }),
      /claim was lost/
    )
    await ownerB.mark_queued(takeover.record.run_id, takeover.preparation_token, publishContextForWorkflow('issue-review'))
    assert.equal((await ownerA.getRun(first.record.run_id))?.status, 'queued')
  } finally { await Promise.all([ownerA.close(), ownerB.close()]) }
})

test('ReviewRunStore recovers an uncertain submission with a fenced claim', async () => {
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = `run-${randomUUID()}`
  try {
    const admission = await store.create_preparing_review_run({ workflow: 'issue-review', run_id: runId, publish_context: {} })
    assert.ok(admission.preparation_token)
    await store.save_prepared_submission(runId, admission.preparation_token, publishContextForWorkflow('issue-review'), { contract_version: 'v4' })
    await store.failPreparation(runId, admission.preparation_token, { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'response lost' })
    const staleToken = await store.claimSubmissionRecovery(runId)
    const currentToken = await store.claimSubmissionRecovery(runId)
    assert.ok(staleToken)
    assert.ok(currentToken)
    assert.notEqual(staleToken, currentToken)
    assert.equal(await store.completeSubmissionRecovery(runId, staleToken), false)
    assert.equal(await store.completeSubmissionRecovery(runId, currentToken), true)
    assert.equal((await store.getRun(runId))?.status, 'queued')
    assert.equal((await store.listActiveRuns()).some(run => run.run_id === runId), true)
  } finally { await store.close() }
})

test('ReviewRunStore fences a stale publisher after another connection takes over', async () => {
  const sharedConnector = connectorId()
  const ownerA = await createStore({ connectorId: sharedConnector, claimTimeoutMs: 0 })
  const ownerB = await createStore({ connectorId: sharedConnector, claimTimeoutMs: 0 })
  const runId = await createQueuedRun(ownerA)
  try {
    const staleToken = await ownerA.claimPublication(runId)
    const currentToken = await ownerB.claimPublication(runId)
    assert.ok(staleToken)
    assert.ok(currentToken)
    assert.notEqual(staleToken, currentToken)
    assert.equal(await ownerA.completePublication(runId, staleToken), false)
    assert.equal(await ownerA.failPublication(runId, staleToken, { message: 'late failure' }, { retry: true }), false)
    assert.equal(await ownerB.completePublication(runId, currentToken), true)
    const record = await ownerA.getRun(runId)
    assert.equal(record?.status, 'published')
  } finally { await Promise.all([ownerA.close(), ownerB.close()]) }
})

test('ReviewRunStore spends retry budget only for the current publication owner', async () => {
  const store = await createStore()
  const runId = await createQueuedRun(store)
  try {
    const token = await store.claimPublication(runId)
    assert.ok(token)
    assert.equal(await store.failPublication(runId, token, { code: 'HTTP_503', message: 'unavailable' }, { retry: true }), true)
    const record = await store.getRun(runId)
    assert.equal(record?.status, 'queued')
    assert.equal((await store.listActiveRuns())[0]?.run_id, runId)
  } finally { await store.close() }
})

test('ReviewRunStore fences publication step commits with the current publication token', async () => {
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = await createQueuedRun(store)
  try {
    const staleToken = await store.claimPublication(runId)
    assert.ok(staleToken)
    await store.initializePublicationSteps(runId, staleToken, ['repository:summary-issue'])
    await store.requirePublicationStepClaim(runId, staleToken, 'repository:summary-issue')

    const currentToken = await store.claimPublication(runId)
    assert.ok(currentToken)
    assert.equal(await store.completePublicationStep(runId, staleToken, 'repository:summary-issue', { id: 7 }), false)
    assert.equal(await store.failPublicationStep(runId, staleToken, 'repository:summary-issue', { message: 'late failure' }), false)
  } finally { await store.close() }
})

test('ReviewRunStore reports an exhausted publication step as deterministic', async () => {
  const store = await createStore()
  const runId = await createQueuedRun(store)
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = await store.claimPublication(runId)
      assert.ok(token)
      if (attempt === 0) await store.initializePublicationSteps(runId, token, ['issue:summary-comment'])
      await store.requirePublicationStepClaim(runId, token, 'issue:summary-comment')
      assert.equal(await store.failPublicationStep(runId, token, 'issue:summary-comment', { message: 'temporary failure' }), true)
      assert.equal(await store.failPublication(runId, token, { message: 'temporary failure' }, { retry: true }), true)
    }

    const finalToken = await store.claimPublication(runId)
    assert.ok(finalToken)
    await assert.rejects(
      store.requirePublicationStepClaim(runId, finalToken, 'issue:summary-comment'),
      (error: unknown) => error instanceof Error &&
        'code' in error && error.code === 'PUBLICATION_STEP_RETRY_EXHAUSTED'
    )
    assert.equal((await store.listPublicationSteps(runId))[0]?.status, 'terminal_failed')
  } finally { await store.close() }
})

test('ReviewRunStore records Runner execution failure without publication failure', async () => {
  const store = await createStore()
  const runId = await createQueuedRun(store)
  try {
    assert.equal(await store.failRunnerExecution(runId, {
      code: 'RUNNER_EXECUTION_FAILED',
      message: 'Agent execution failed.'
    }), true)
    const record = await store.getRun(runId)
    assert.equal(record?.status, 'failed')
    assert.equal(record?.failure_code, 'RUNNER_EXECUTION_FAILED')
    assert.equal(await store.claimPublication(runId), null)
  } finally { await store.close() }
})

test('ReviewRunStore renews a publication claim before another owner can take it', async () => {
  const sharedConnector = connectorId()
  const ownerA = await createStore({ connectorId: sharedConnector, claimTimeoutMs: 1_000 })
  const ownerB = await createStore({ connectorId: sharedConnector, claimTimeoutMs: 1_000 })
  const runId = await createQueuedRun(ownerA)
  const observer = new Pool({ connectionString: requireTestDatabase() })
  try {
    const token = await ownerA.claimPublication(runId)
    assert.ok(token)
    await observer.query('UPDATE publications SET claimed_at=clock_timestamp()-interval \'2 seconds\' WHERE run_id=$1 AND connector_id=$2', [runId, sharedConnector])
    assert.equal(await ownerA.renewPublicationClaim(runId, token), true)
    assert.equal(await ownerB.claimPublication(runId), null)
  } finally {
    await observer.end()
    await Promise.all([ownerA.close(), ownerB.close()])
  }
})

test('ReviewRunStore applies diagnostics filters before the limit', async () => {
  const store = await createStore()
  const failedRunId = await createQueuedRun(store)
  await store.failRunnerExecution(failedRunId, { code: 'RUNNER_EXECUTION_FAILED', message: 'failed' })
  const successfulRunId = await createQueuedRun(store)
  try {
    const failed = await store.listRunsForDiagnostics({ failed_only: true, limit: 1 })
    assert.deepEqual(failed.map(run => run.run_id), [failedRunId])
    const queued = await store.listRunsForDiagnostics({ status: 'queued', limit: 1 })
    assert.deepEqual(queued.map(run => run.run_id), [successfulRunId])
  } finally { await store.close() }
})
