import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { ReviewRunStore } from '../../src/index.js'

function databaseUrl () {
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
    const first = await store.admit_review_run({
      run_id: `run-${randomUUID()}`,
      workflow: 'issue-review',
      publish_context: {},
      ingress_kind: 'github_webhook',
      ingress_key: ingressKey
    })
    const replay = await store.admit_review_run({
      run_id: `discarded-${randomUUID()}`,
      workflow: 'issue-review',
      publish_context: {},
      ingress_kind: 'github_webhook',
      ingress_key: ingressKey
    })

    assert.equal(first.created, true)
    assert.equal(replay.created, false)
    assert.equal(replay.record.run_id, first.record.run_id)
  } finally {
    await store.close()
  }
})

test('Control Plane store fences reads by connector', async () => {
  const runId = `run-${randomUUID()}`
  const first = new ReviewRunStore({ connectionString: databaseUrl(), connectorId: `first:${randomUUID()}` })
  const second = new ReviewRunStore({ connectionString: databaseUrl(), connectorId: `second:${randomUUID()}` })
  await Promise.all([first.initialize(), second.initialize()])
  try {
    await first.create_preparing_review_run({
      run_id: runId,
      workflow: 'repository-review',
      publish_context: {}
    })
    assert.equal(await second.getRun(runId), null)
  } finally {
    await Promise.all([first.close(), second.close()])
  }
})
