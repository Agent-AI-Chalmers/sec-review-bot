import assert from 'node:assert/strict'
import test from 'node:test'

import { recoverReviewRunSubmission, type ReviewRunRecord } from '../src/index.js'

function run(input: Record<string, unknown> | null = { contract_version: 'v5' }): ReviewRunRecord {
  return {
    run_id: 'run-1',
    workflow: 'issue-review',
    publish_context: {},
    ...(input === null ? {} : { runner_input: input }),
    status: 'recovering',
    runner_status: 'recovering',
    publication_status: 'pending',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    published_at: null,
    failure_code: null,
    failure_message: null,
    artifact_storage: null
  }
}

function store(
  overrides: Partial<Parameters<typeof recoverReviewRunSubmission>[0]> = {}
): Parameters<typeof recoverReviewRunSubmission>[0] {
  return {
    async claimSubmissionRecovery() {
      return 'claim-1'
    },
    async completeSubmissionRecovery() {
      return true
    },
    async failSubmissionRecovery() {
      return true
    },
    ...overrides
  }
}

test('submission recovery replays the persisted input and commits its claim', async () => {
  const events: unknown[][] = []
  const result = await recoverReviewRunSubmission(
    store({
      async completeSubmissionRecovery(runId, token) {
        events.push(['complete', runId, token])
        return true
      }
    }),
    run(),
    {
      async submit(request) {
        events.push(['submit', request])
      },
      classifyError: (error) => {
        throw error
      }
    }
  )

  assert.equal(result.status, 'recovered')
  assert.deepEqual(events, [
    ['submit', { workflow: 'issue-review', run_id: 'run-1', input: { contract_version: 'v5' } }],
    ['complete', 'run-1', 'claim-1']
  ])
})

test('submission recovery persists uncertainty for a later retry', async () => {
  const failures: unknown[][] = []
  const transportError = new Error('response lost')
  const result = await recoverReviewRunSubmission(
    store({
      async failSubmissionRecovery(...args) {
        failures.push(args)
        return true
      }
    }),
    run(),
    {
      async submit() {
        throw transportError
      },
      classifyError: (error) => ({
        uncertain: true,
        code: 'SUBMISSION_STATE_UNCERTAIN',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  )

  assert.deepEqual(result, { status: 'deferred', error: transportError })
  assert.deepEqual(failures, [
    ['run-1', 'claim-1', { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'response lost' }]
  ])
})

test('submission recovery records missing persisted input without calling Runner', async () => {
  let submitted = false
  let failure: { code?: string | null; message: string } | undefined
  const result = await recoverReviewRunSubmission(
    store({
      async failSubmissionRecovery(_runId, _token, error) {
        failure = error
        return true
      }
    }),
    run(null),
    {
      async submit() {
        submitted = true
      },
      classifyError: (error) => {
        throw error
      }
    }
  )

  assert.equal(result.status, 'input_missing')
  assert.equal(submitted, false)
  assert.equal(failure?.code, 'SUBMISSION_RECOVERY_INPUT_MISSING')
})
