import assert from 'node:assert/strict'
import test from 'node:test'

import { observeRunnerRun, type ReviewRunRecord } from '../src/index.js'

const run: ReviewRunRecord = {
  run_id: 'run-1',
  workflow: 'issue-review',
  publish_context: {},
  preparation: {
    status: 'submitted',
    attempt_count: 1,
    started_at: '2026-01-01T00:00:01.000Z',
    finished_at: '2026-01-01T00:00:02.000Z',
    updated_at: '2026-01-01T00:00:03.000Z',
    failure_code: null,
    disconnect_reason: null
  },
  execution: {
    status: 'queued',
    started_at: null,
    finished_at: null,
    updated_at: '2026-01-01T00:00:00.000Z'
  },
  publication: {
    status: 'pending',
    started_at: null,
    finished_at: null,
    updated_at: '2026-01-01T00:00:00.000Z'
  },
  created_at: '2026-01-01T00:00:00.000Z',
  failure_code: null,
  failure_message: null,
  artifact_storage: null,
  notices: []
}
function store(events: unknown[][]): Parameters<typeof observeRunnerRun>[0] {
  return {
    async markRunning(id) {
      events.push(['running', id])
      return true
    },
    async recordRunnerSuccess(id, result, artifact) {
      events.push(['succeeded', id, result, artifact])
      return true
    },
    async failRunnerExecution(id, failure, artifact) {
      events.push(['failed', id, failure, artifact])
      return true
    },
    async touchObservation(id) {
      events.push(['touched', id])
    }
  }
}

test('active Runner execution advances without publishing', async () => {
  const events: unknown[][] = []
  assert.strictEqual(
    await observeRunnerRun(
      store(events),
      run,
      async () => ({
        run_id: 'run-1',
        workflow: 'issue-review',
        status: 'running'
      }),
      () => false
    ),
    'active'
  )
  assert.deepStrictEqual(events, [['running', 'run-1']])
})

test('successful Runner result is durably recorded for later publication', async () => {
  const events: unknown[][] = []
  const artifact = { status: 'unavailable' as const }
  assert.strictEqual(
    await observeRunnerRun(
      store(events),
      run,
      async () => ({
        run_id: 'run-1',
        workflow: 'issue-review',
        status: 'succeeded',
        result: { answer: 42 },
        artifact_storage: artifact,
        notices: []
      }),
      () => false
    ),
    'succeeded'
  )
  assert.deepStrictEqual(events, [
    ['succeeded', 'run-1', { answer: 42 }, artifact]
  ])
})

test('transient polling failure leaves the run active', async () => {
  const events: unknown[][] = []
  assert.strictEqual(
    await observeRunnerRun(
      store(events),
      run,
      async () => {
        throw new Error('temporary')
      },
      () => false
    ),
    'poll_retry'
  )
  assert.deepStrictEqual(events, [])
})

test('terminal polling failure fails the run without publication', async () => {
  const events: unknown[][] = []
  const error = Object.assign(new Error('missing'), {
    code: 'RUNNER_RUN_NOT_FOUND'
  })
  assert.strictEqual(
    await observeRunnerRun(
      store(events),
      run,
      async () => {
        throw error
      },
      () => true
    ),
    'failed'
  )
  assert.deepStrictEqual(events, [
    [
      'failed',
      'run-1',
      { code: 'RUNNER_RUN_NOT_FOUND', message: 'missing' },
      undefined
    ]
  ])
})

test('Runner failure records its artifact atomically with the terminal failure', async () => {
  const events: unknown[][] = []
  const artifact = { status: 'failed' as const, error: 'upload failed' }
  assert.strictEqual(
    await observeRunnerRun(
      store(events),
      run,
      async () => ({
        run_id: 'run-1',
        workflow: 'issue-review',
        status: 'failed',
        artifact_storage: artifact,
        notices: [],
        error: { code: 'RUNNER_FAILED', message: 'failed' }
      }),
      () => false
    ),
    'failed'
  )
  assert.deepStrictEqual(events, [
    ['failed', 'run-1', { code: 'RUNNER_FAILED', message: 'failed' }, artifact]
  ])
})

test('a stale running observation does not emit a state-change event', async () => {
  const events: unknown[] = []
  const result = await observeRunnerRun(
    {
      ...store([]),
      markRunning: async () => false
    },
    run,
    async () => ({
      run_id: 'run-1',
      workflow: 'issue-review',
      status: 'running'
    }),
    () => false,
    (event) => events.push(event)
  )
  assert.strictEqual(result, 'active')
  assert.deepStrictEqual(events, [])
})

test('a stale successful observation does not emit a terminal event', async () => {
  const events: unknown[] = []
  const result = await observeRunnerRun(
    {
      ...store([]),
      recordRunnerSuccess: async () => false
    },
    run,
    async () => ({
      run_id: 'run-1',
      workflow: 'issue-review',
      status: 'succeeded',
      result: { answer: 42 }
    }),
    () => false,
    (event) => events.push(event)
  )
  assert.strictEqual(result, 'succeeded')
  assert.deepStrictEqual(events, [])
})
