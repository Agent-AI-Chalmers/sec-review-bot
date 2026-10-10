import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { ReviewRunStore } from '../../src/index.js'

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

function requireTestDatabase(): string {
  if (!connectionString)
    throw new Error('TEST_DATABASE_URL is required for PostgreSQL store tests.')
  return connectionString
}

async function createStore(): Promise<ReviewRunStore> {
  const store = new ReviewRunStore({
    connectionString: requireTestDatabase(),
    connectorId: `test:${randomUUID()}`
  })
  await store.initialize()
  return store
}

/** A run in the state `claimNextPublication` looks for. */
async function createPublishableRun(store: ReviewRunStore): Promise<string> {
  const runId = `run-${randomUUID()}`
  const admission = await store.create_preparing_review_run({
    workflow: 'issue-review',
    run_id: runId,
    publish_context: {}
  })
  assert.ok(admission.preparation_token)
  await store.mark_queued(runId, admission.preparation_token, {})
  assert.equal(
    await store.recordRunnerSuccess(runId, { run_id: runId }, { status: 'unavailable' }),
    true
  )
  return runId
}

test('a waiting claim returns as soon as publishable work appears', async () => {
  // The wait exists so a run that becomes publishable mid-interval is picked up then,
  // rather than at the next poll. A claim that ignored its wait argument and answered
  // immediately would find nothing here and fail this test.
  const store = await createStore()
  try {
    const started = Date.now()
    const pending = store.claimNextPublication(5_000)
    // Let the first attempt run and find nothing before any work exists.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const runId = await createPublishableRun(store)

    const work = await pending
    const elapsed = Date.now() - started

    assert.equal(work?.run_id, runId)
    assert.ok(elapsed < 5_000, `the claim should have returned early, took ${elapsed}ms`)
  } finally {
    await store.close()
  }
})

test('a waiting claim gives up when its wait elapses', async () => {
  // The wait must stay bounded: the caller's poll timer is the backstop, so a claim that
  // never finds work returns null instead of holding the request open.
  const store = await createStore()
  try {
    const started = Date.now()
    const work = await store.claimNextPublication(800)
    const elapsed = Date.now() - started

    assert.equal(work, null)
    assert.ok(elapsed >= 700, `the claim should have waited, took ${elapsed}ms`)
  } finally {
    await store.close()
  }
})
