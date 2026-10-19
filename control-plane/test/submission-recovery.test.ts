import assert from 'node:assert/strict'
import test from 'node:test'

import {
  recoverReviewRunSubmission,
  type ReviewRunRecord
} from '../src/index.js'

function run(
  input: Record<string, unknown> | null = { contract_version: 'v6' }
): ReviewRunRecord {
  return {
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
      expiry_blocked_reason: null
    },
    ...(input === null ? {} : { runner_input: input }),
    execution: {
      status: 'uncertain',
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
    failure_notice: null
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

  assert.strictEqual(result.status, 'recovered')
  assert.deepStrictEqual(events, [
    [
      'submit',
      {
        workflow: 'issue-review',
        run_id: 'run-1',
        input: { contract_version: 'v6' }
      }
    ],
    ['complete', 'run-1', 'claim-1']
  ])
})

test('submission recovery leaves an uncertain replay untouched', async () => {
  // An unknown replay outcome is not a failure: the Runner may have accepted the request, so
  // nothing may be concluded and the state must stay `uncertain`. The claim is deliberately left
  // in place too - the run becomes claimable again when its lease expires, which is the pace it
  // had before this path existed. Clearing it would replay a failing submission every tick.
  const concluded: unknown[][] = []
  const transportError = new Error('response lost')
  const result = await recoverReviewRunSubmission(
    store({
      async failSubmissionRecovery(...args) {
        concluded.push(args)
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

  assert.deepStrictEqual(result, { status: 'deferred', error: transportError })
  assert.deepStrictEqual(
    concluded,
    [],
    'nothing may be concluded while the outcome is unknown'
  )
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

  assert.strictEqual(result.status, 'input_missing')
  assert.strictEqual(submitted, false)
  assert.strictEqual(failure?.code, 'SUBMISSION_RECOVERY_INPUT_MISSING')
})
