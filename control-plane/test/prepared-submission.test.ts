import assert from 'node:assert/strict'
import test from 'node:test'

import { submitPreparedRun, type ReviewRunRecord } from '../src/index.js'
import { ExecutionSubmissionUncertainError } from '../src/execution-client.js'

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
    status: 'pending',
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

test('prepared submission persists input before crossing the Execution boundary', async () => {
  const events: string[] = []
  const result = await submitPreparedRun(
    {
      async getRun() {
        return run
      },
      async savePreparedSubmission() {
        events.push('persist')
      },
      async markQueued() {
        events.push('queued')
      },
      async failPreparation() {
        assert.fail('successful submission must not fail')
      }
    },
    {
      runId: 'run-1',
      preparationToken: 'claim-1',
      publishContext: { issue: 7 },
      input: { api_version: 'v1' }
    },
    async (request) => {
      events.push('submit')
      assert.strictEqual(request.run_id, 'run-1')
    }
  )
  assert.deepStrictEqual(events, ['persist', 'submit', 'queued'])
  assert.deepStrictEqual(result, {
    run_id: 'run-1',
    workflow: 'issue-review',
    status: 'queued'
  })
})

test('uncertain Execution submission is persisted for recovery', async () => {
  let failure: unknown
  const error = new ExecutionSubmissionUncertainError('response lost')
  await assert.rejects(
    submitPreparedRun(
      {
        async getRun() {
          return run
        },
        async savePreparedSubmission() {},
        async markQueued() {
          assert.fail('uncertain submission must not queue')
        },
        async failPreparation(_runId, _token, value) {
          failure = value
        }
      },
      {
        runId: 'run-1',
        preparationToken: 'claim-1',
        publishContext: {},
        input: { api_version: 'v1' }
      },
      async () => {
        throw error
      }
    ),
    error
  )
  assert.deepStrictEqual(failure, {
    code: 'SUBMISSION_STATE_UNCERTAIN',
    message: 'response lost'
  })
})

test('a queued-state write failure after Execution accepts is recoverable uncertainty', async () => {
  let failure: unknown
  await assert.rejects(
    submitPreparedRun(
      {
        async getRun() {
          return run
        },
        async savePreparedSubmission() {},
        async markQueued() {
          throw new Error('database unavailable')
        },
        async failPreparation(_runId, _token, value) {
          failure = value
        }
      },
      {
        runId: 'run-1',
        preparationToken: 'claim-1',
        publishContext: {},
        input: { api_version: 'v1' }
      },
      async () => {}
    ),
    /database unavailable/
  )
  assert.deepStrictEqual(failure, {
    code: 'SUBMISSION_STATE_UNCERTAIN',
    message: 'database unavailable'
  })
})
