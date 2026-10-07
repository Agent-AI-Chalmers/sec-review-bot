import assert from 'node:assert/strict'
import test from 'node:test'

import { observeRunnerRun, type ReviewRunRecord } from '../src/index.js'

const run: ReviewRunRecord = { run_id: 'run-1', workflow: 'issue-review', publish_context: {}, status: 'queued', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', published_at: null, failure_code: null, failure_message: null, artifact_publication: null }
function store (events: unknown[][]): Parameters<typeof observeRunnerRun>[0] { return { async markRunning (id) { events.push(['running', id]) }, async recordRunnerSuccess (id, result, artifact) { events.push(['succeeded', id, result, artifact]); return true }, async recordArtifactPublication (id, artifact) { events.push(['artifact', id, artifact]) }, async failRunnerExecution (id, failure) { events.push(['failed', id, failure]); return true } } }

test('active Runner execution advances without publishing', async () => {
  const events: unknown[][] = []
  assert.equal(await observeRunnerRun(store(events), run, async () => ({ run_id: 'run-1', workflow: 'issue-review', status: 'running' }), () => false), 'active')
  assert.deepEqual(events, [['running', 'run-1']])
})

test('successful Runner result is durably recorded for later publication', async () => {
  const events: unknown[][] = []
  const artifact = { status: 'not_available' as const }
  assert.equal(await observeRunnerRun(store(events), run, async () => ({ run_id: 'run-1', workflow: 'issue-review', status: 'succeeded', result: { answer: 42 }, artifact_publication: artifact }), () => false), 'succeeded')
  assert.deepEqual(events, [['succeeded', 'run-1', { answer: 42 }, artifact]])
})

test('transient polling failure leaves the run active', async () => {
  const events: unknown[][] = []
  assert.equal(await observeRunnerRun(store(events), run, async () => { throw new Error('temporary') }, () => false), 'poll_retry')
  assert.deepEqual(events, [])
})

test('terminal polling failure fails the run without publication', async () => {
  const events: unknown[][] = []
  const error = Object.assign(new Error('missing'), { code: 'RUNNER_RUN_NOT_FOUND' })
  assert.equal(await observeRunnerRun(store(events), run, async () => { throw error }, () => true), 'failed')
  assert.deepEqual(events, [['failed', 'run-1', { code: 'RUNNER_RUN_NOT_FOUND', message: 'missing' }]])
})
