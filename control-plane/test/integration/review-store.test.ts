import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { ReviewRunStore } from '../../src/index.js'

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

test('run queries survive a fresh store connection and preserve stable pagination', async () => {
  const connectorId = `query-restart:${randomUUID()}`
  const first = new ReviewRunStore({ connectionString: databaseUrl(), connectorId })
  await first.initialize()
  const runIds = [`run-${randomUUID()}`, `run-${randomUUID()}`]
  try {
    for (const run_id of runIds) {
      await first.create_preparing_review_run({
        run_id,
        workflow: 'issue-review',
        publish_context: { private: true },
        runner_input: { secret: true }
      })
    }
  } finally {
    await first.close()
  }

  const restarted = new ReviewRunStore({ connectionString: databaseUrl(), connectorId })
  await restarted.initialize()
  try {
    const firstPage = await restarted.listRuns({ limit: 1 })
    assert.equal(firstPage.length, 1)
    const cursor = Buffer.from(`${firstPage[0]?.created_at}|${firstPage[0]?.run_id}`).toString(
      'base64url'
    )
    const secondPage = await restarted.listRuns({ limit: 1, cursor })
    assert.equal(secondPage.length, 1)
    assert.notEqual(secondPage[0]?.run_id, firstPage[0]?.run_id)
    assert.equal((await restarted.getRun(runIds[0] ?? ''))?.runner_input?.secret, true)
  } finally {
    await restarted.close()
  }
})
