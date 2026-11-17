import { expect, test } from 'vitest'

import { ExecutionSubmissionUncertainError } from '../src/execution-client.js'
import { submitPreparedRun } from '../src/runtime/prepared-submission.js'
import type { ReviewRunRecord } from '../src/shapes.js'

const run: ReviewRunRecord = {
  run_id: 'run-1',
  workflow: 'issue-review',
  source_platform: 'github',
  connector_id: 'github-integration:test',
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
      queries: {
        async getRun() {
          return run
        }
      },
      submissionTransitions: {
        async savePreparedSubmission() {
          events.push('persist')
        },
        async markQueued() {
          events.push('queued')
        }
      },
      preparations: {
        async fail() {
          expect.unreachable('successful submission must not fail')
        }
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
      expect(request.run_id).toBe('run-1')
    }
  )
  expect(events).toStrictEqual(['persist', 'submit', 'queued'])
  expect(result).toStrictEqual({
    run_id: 'run-1',
    workflow: 'issue-review',
    status: 'queued'
  })
})

test('uncertain Execution submission is persisted for recovery', async () => {
  let failure: unknown
  const error = new ExecutionSubmissionUncertainError('response lost')
  await expect(
    submitPreparedRun(
      {
        queries: {
          async getRun() {
            return run
          }
        },
        submissionTransitions: {
          async savePreparedSubmission() {},
          async markQueued() {
            expect.unreachable('uncertain submission must not queue')
          }
        },
        preparations: {
          async fail(_runId, _token, value) {
            failure = value
            return { retry_scheduled: false }
          }
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
    )
  ).rejects.toMatchObject({
    ...error,
    name: error.name,
    message: error.message
  })
  expect(failure).toStrictEqual({
    code: 'SUBMISSION_STATE_UNCERTAIN',
    message: 'response lost'
  })
})

test('a queued-state write failure after Execution accepts is recoverable uncertainty', async () => {
  let failure: unknown
  await expect(
    submitPreparedRun(
      {
        queries: {
          async getRun() {
            return run
          }
        },
        submissionTransitions: {
          async savePreparedSubmission() {},
          async markQueued() {
            throw new Error('database unavailable')
          }
        },
        preparations: {
          async fail(_runId, _token, value) {
            failure = value
            return { retry_scheduled: false }
          }
        }
      },
      {
        runId: 'run-1',
        preparationToken: 'claim-1',
        publishContext: {},
        input: { api_version: 'v1' }
      },
      async () => {}
    )
  ).rejects.toThrow(/database unavailable/)
  expect(failure).toStrictEqual({
    code: 'SUBMISSION_STATE_UNCERTAIN',
    message: 'database unavailable'
  })
})
