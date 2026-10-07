import assert from 'node:assert/strict'
import test from 'node:test'

import { submitPreparedRun, type ReviewRunRecord } from '../src/index.js'
import { RunnerSubmissionUncertainError } from '../src/runner-client.js'

const run: ReviewRunRecord = {
  run_id: 'run-1',
  workflow: 'issue-review',
  publish_context: {},
  status: 'preparing',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  published_at: null,
  failure_code: null,
  failure_message: null,
  artifact_publication: null
}

test('prepared submission persists input before crossing the Runner boundary', async () => {
  const events: string[] = []
  const result = await submitPreparedRun(
    {
      async getRun() {
        return run
      },
      async save_prepared_submission() {
        events.push('persist')
      },
      async mark_queued() {
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
      input: { contract_version: 'v5' }
    },
    async (request) => {
      events.push('submit')
      assert.equal(request.run_id, 'run-1')
    }
  )
  assert.deepEqual(events, ['persist', 'submit', 'queued'])
  assert.deepEqual(result, { run_id: 'run-1', workflow: 'issue-review', status: 'queued' })
})

test('uncertain Runner submission is persisted for recovery', async () => {
  let failure: unknown
  const error = new RunnerSubmissionUncertainError('response lost')
  await assert.rejects(
    submitPreparedRun(
      {
        async getRun() {
          return run
        },
        async save_prepared_submission() {},
        async mark_queued() {
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
        input: { contract_version: 'v5' }
      },
      async () => {
        throw error
      }
    ),
    error
  )
  assert.deepEqual(failure, { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'response lost' })
})

test('a queued-state write failure after Runner accepts is recoverable uncertainty', async () => {
  let failure: unknown
  await assert.rejects(
    submitPreparedRun(
      {
        async getRun() {
          return run
        },
        async save_prepared_submission() {},
        async mark_queued() {
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
        input: { contract_version: 'v5' }
      },
      async () => {}
    ),
    /database unavailable/
  )
  assert.deepEqual(failure, { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'database unavailable' })
})
