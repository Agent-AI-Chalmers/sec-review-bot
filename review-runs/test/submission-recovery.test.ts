import assert from 'node:assert/strict'
import test from 'node:test'

import {
  concludeExhaustedSubmissionRecovery,
  MAX_SUBMISSION_RECOVERY_ATTEMPTS,
  recoverReviewRunSubmission,
  type ReviewRunRecord
} from '../src/index.js'

function run(
  input: Record<string, unknown> | null = { api_version: 'v1' }
): ReviewRunRecord {
  return {
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
    ...(input === null ? {} : { execution_input: input }),
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
    notices: []
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
    async submissionRecoveryAttemptCount() {
      return 0
    },
    async disconnectExhaustedSubmissionRecovery() {
      return false
    },
    async recordUnknownRecoveryOutcome() {
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
        input: { api_version: 'v1' }
      }
    ],
    ['complete', 'run-1', 'claim-1']
  ])
})

test('submission recovery leaves an uncertain replay untouched', async () => {
  // An unknown replay outcome is not a failure: the Execution may have accepted the request, so
  // nothing may be concluded and the state must stay `uncertain`. The claim is deliberately left
  // in place too - the run becomes claimable again when its lease expires, which is the pace it
  // had before this path existed. Clearing it would replay a failing submission every tick.
  const concluded: unknown[][] = []
  const counted: string[] = []
  const transportError = new Error('response lost')
  const result = await recoverReviewRunSubmission(
    store({
      async failSubmissionRecovery(...args) {
        concluded.push(args)
        return true
      },
      async recordUnknownRecoveryOutcome(_runId, token) {
        counted.push(token)
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
  // The attempt is counted even though nothing is concluded: the budget is what eventually lets
  // an otherwise endless uncertainty end, so it has to advance on every unknown outcome.
  assert.deepStrictEqual(counted, ['claim-1'])
  assert.deepStrictEqual(
    concluded,
    [],
    'nothing may be concluded while the outcome is unknown'
  )
})

test('submission recovery records missing persisted input without calling Execution', async () => {
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

test('an uncertain submission disconnects once its replay budget is spent', async () => {
  // A submission whose replays never resolve would otherwise stay `uncertain` forever: no axis
  // must stop automation, but it is not evidence that the Execution rejected the submission.
  const result = await concludeExhaustedSubmissionRecovery(
    store({
      async submissionRecoveryAttemptCount() {
        return MAX_SUBMISSION_RECOVERY_ATTEMPTS
      },
      async disconnectExhaustedSubmissionRecovery(_runId, maxAttempts) {
        assert.strictEqual(maxAttempts, MAX_SUBMISSION_RECOVERY_ATTEMPTS)
        return true
      }
    }),
    run()
  )

  assert.deepStrictEqual(result, { status: 'disconnected' })
})

test('a replay budget that is not spent yet leaves the run to the normal replay path', async () => {
  let taken = false
  const result = await concludeExhaustedSubmissionRecovery(
    store({
      async submissionRecoveryAttemptCount() {
        return MAX_SUBMISSION_RECOVERY_ATTEMPTS - 1
      },
      async disconnectExhaustedSubmissionRecovery() {
        taken = true
        return true
      }
    }),
    run()
  )

  assert.strictEqual(result, null)
  assert.strictEqual(
    taken,
    false,
    'an unfinished budget must not conclude the run'
  )
})

test('losing the race to another owner reports nothing', async () => {
  // Two processes can both see a spent budget. `disconnectExhaustedSubmissionRecovery` is gated on the
  // claim, so only one wins; the loser must stay silent rather than report a conclusion it did
  // not make.
  const result = await concludeExhaustedSubmissionRecovery(
    store({
      async submissionRecoveryAttemptCount() {
        return MAX_SUBMISSION_RECOVERY_ATTEMPTS
      },
      async disconnectExhaustedSubmissionRecovery() {
        return false
      }
    }),
    run()
  )

  assert.strictEqual(result, null)
})
