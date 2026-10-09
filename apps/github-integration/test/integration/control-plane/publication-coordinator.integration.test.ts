import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { ReviewRunStore } from '../../../../../control-plane/src/index.js'
import { publishContextForWorkflow } from '../../publish-context-fixtures.js'

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
async function store(
  connectorId = `publisher:${randomUUID()}`,
  claimTimeoutMs = 60_000
): Promise<ReviewRunStore> {
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required for publisher store tests.')
  const value = new ReviewRunStore({ connectionString, connectorId, claimTimeoutMs })
  await value.initialize()
  return value
}
async function successfulRun(value: ReviewRunStore): Promise<string> {
  const runId = `run-${randomUUID()}`
  const context = publishContextForWorkflow('issue-review')
  const admission = await value.create_preparing_review_run({
    run_id: runId,
    workflow: 'issue-review',
    publish_context: context
  })
  assert.ok(admission.preparation_token)
  await value.mark_queued(runId, admission.preparation_token, context)
  await value.recordRunnerSuccess(
    runId,
    { run_id: runId, review_record: { analysis: { verdict: 'no-findings' } } },
    { status: 'unavailable' }
  )
  return runId
}

test('publication work is unavailable until Control Plane records Runner success', async () => {
  const value = await store()
  try {
    const admission = await value.create_preparing_review_run({
      run_id: `run-${randomUUID()}`,
      workflow: 'issue-review',
      publish_context: publishContextForWorkflow('issue-review')
    })
    assert.ok(admission.preparation_token)
    await value.mark_queued(
      admission.record.run_id,
      admission.preparation_token,
      publishContextForWorkflow('issue-review')
    )
    assert.equal(await value.claimNextPublication(), null)
  } finally {
    await value.close()
  }
})

test('publication claim returns the persisted opaque result, context, and artifact', async () => {
  const value = await store()
  try {
    const runId = await successfulRun(value)
    const work = await value.claimNextPublication()
    assert.equal(work?.run_id, runId)
    assert.equal(work?.claim_token.length, 36)
    assert.deepEqual(work?.artifact_storage, { status: 'unavailable' })
    assert.equal((work?.workflow_result as { run_id?: string }).run_id, runId)
    assert.deepEqual(work?.publish_context, publishContextForWorkflow('issue-review'))
  } finally {
    await value.close()
  }
})

test('concurrent publication consumers cannot own the same ready run', async () => {
  const connectorId = `publisher:${randomUUID()}`
  const first = await store(connectorId)
  const second = await store(connectorId)
  try {
    await successfulRun(first)
    const claims = await Promise.all([first.claimNextPublication(), second.claimNextPublication()])
    assert.equal(claims.filter(Boolean).length, 1)
  } finally {
    await first.close()
    await second.close()
  }
})

test('a retryable publication failure becomes claimable again', async () => {
  const value = await store()
  try {
    const runId = await successfulRun(value)
    const work = await value.claimNextPublication()
    assert.ok(work)
    assert.equal(
      await value.failPublication(
        runId,
        work.claim_token,
        { message: 'GitHub unavailable' },
        { retry: true }
      ),
      true
    )
    assert.equal((await value.claimNextPublication())?.run_id, runId)
  } finally {
    await value.close()
  }
})
