import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_UNRESOLVED_SUBMISSION_RECOVERIES,
  recoverReviewRunSubmission
} from '../src/runtime/submission-recovery.js'
import type { ReviewRunRecord } from '../src/shapes.js'

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

type RecoveryStore = Parameters<typeof recoverReviewRunSubmission>[0]
type FlatRecoveryStore = {
  claimSubmissionRecovery: RecoveryStore['executions']['claimSubmissionRecovery']
  completeSubmissionRecovery: RecoveryStore['submissionTransitions']['completeSubmissionRecovery']
  failSubmissionRecovery: RecoveryStore['submissionTransitions']['failSubmissionRecovery']
  disconnectExhaustedSubmissionRecovery: RecoveryStore['executions']['disconnectExhaustedSubmissionRecovery']
  recordUnknownRecoveryOutcome: RecoveryStore['executions']['recordUnknownRecoveryOutcome']
}

/** The behaviours these tests vary, kept flat; recovery reads them through their axes. */
function store(overrides: Partial<FlatRecoveryStore> = {}): RecoveryStore {
  const flat: FlatRecoveryStore = {
    async claimSubmissionRecovery() {
      return 'claim-1'
    },
    async completeSubmissionRecovery() {
      return true
    },
    async failSubmissionRecovery() {
      return true
    },
    async disconnectExhaustedSubmissionRecovery() {
      return false
    },
    async recordUnknownRecoveryOutcome() {
      return true
    },
    ...overrides
  }
  return {
    executions: {
      claimSubmissionRecovery: (runId, limit) =>
        flat.claimSubmissionRecovery(runId, limit),
      disconnectExhaustedSubmissionRecovery: (runId, maxUnresolvedRecoveries) =>
        flat.disconnectExhaustedSubmissionRecovery(
          runId,
          maxUnresolvedRecoveries
        ),
      recordUnknownRecoveryOutcome: (runId, token) =>
        flat.recordUnknownRecoveryOutcome(runId, token)
    },
    submissionTransitions: {
      completeSubmissionRecovery: (runId, token) =>
        flat.completeSubmissionRecovery(runId, token),
      failSubmissionRecovery: (runId, token, error) =>
        flat.failSubmissionRecovery(runId, token, error)
    }
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

  assert.strictEqual(result.outcome, 'recovered')
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

test('submission recovery propagates a commit failure after Execution accepts', async () => {
  // A local write failure cannot establish that the accepted remote execution failed.
  const databaseError = new Error('database unavailable')
  const failures: unknown[] = []
  let accepted = false
  await assert.rejects(
    recoverReviewRunSubmission(
      store({
        async completeSubmissionRecovery() {
          assert.strictEqual(accepted, true)
          throw databaseError
        },
        async failSubmissionRecovery(...args) {
          failures.push(args)
          return true
        }
      }),
      run(),
      {
        async submit() {
          accepted = true
        },
        classifyError: (error) => ({
          uncertain: false,
          message: String(error)
        })
      }
    ),
    databaseError
  )
  assert.deepStrictEqual(failures, [])
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

  assert.deepStrictEqual(result, { outcome: 'deferred', error: transportError })
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

  assert.strictEqual(result.outcome, 'input_missing')
  assert.strictEqual(submitted, false)
  assert.strictEqual(failure?.code, 'SUBMISSION_RECOVERY_INPUT_MISSING')
})

const acceptedSubmission = {
  async submit() {},
  classifyError(error: unknown): never {
    throw error
  }
}

test('recovery disconnects an exhausted run before claiming or submitting', async () => {
  const result = await recoverReviewRunSubmission(
    store({
      async disconnectExhaustedSubmissionRecovery(_runId, limit) {
        assert.equal(limit, MAX_UNRESOLVED_SUBMISSION_RECOVERIES)
        return true
      },
      async claimSubmissionRecovery() {
        throw new Error('must not claim')
      }
    }),
    run(),
    {
      ...acceptedSubmission,
      async submit() {
        throw new Error('must not submit')
      }
    }
  )
  assert.deepEqual(result, { outcome: 'disconnected' })
})

test('recovery checks the budget before claiming and replaying', async () => {
  const events: string[] = []
  const result = await recoverReviewRunSubmission(
    store({
      async disconnectExhaustedSubmissionRecovery() {
        events.push('check')
        return false
      },
      async claimSubmissionRecovery(_runId, limit) {
        assert.equal(limit, MAX_UNRESOLVED_SUBMISSION_RECOVERIES)
        events.push('claim')
        return 'claim'
      }
    }),
    run(),
    {
      ...acceptedSubmission,
      async submit() {
        events.push('submit')
      }
    }
  )
  assert.equal(result.outcome, 'recovered')
  assert.deepEqual(events, ['check', 'claim', 'submit'])
})

test('recovery does not replay when neither disconnection nor claim is available', async () => {
  const result = await recoverReviewRunSubmission(
    store({
      async disconnectExhaustedSubmissionRecovery() {
        return false
      },
      async claimSubmissionRecovery() {
        return null
      }
    }),
    run(),
    {
      ...acceptedSubmission,
      async submit() {
        throw new Error('must not submit')
      }
    }
  )
  assert.deepEqual(result, { outcome: 'claim_unavailable' })
})

for (const outcome of [
  'accepted',
  'unknown',
  'rejected',
  'input_missing'
] as const) {
  test(`recovery reports claim loss when recording ${outcome} is refused`, async () => {
    const result = await recoverReviewRunSubmission(
      store({
        async completeSubmissionRecovery() {
          return false
        },
        async failSubmissionRecovery() {
          return false
        },
        async recordUnknownRecoveryOutcome() {
          return false
        }
      }),
      run(outcome === 'input_missing' ? null : { api_version: 'v1' }),
      {
        async submit() {
          if (outcome === 'unknown' || outcome === 'rejected')
            throw new Error('remote outcome')
        },
        classifyError: (error) => ({
          uncertain: outcome === 'unknown',
          message: String(error)
        })
      }
    )
    assert.deepEqual(result, { outcome: 'claim_lost' })
  })
}

test('a confirmed rejection reports failure only after recording it', async () => {
  const error = new Error('rejected')
  const result = await recoverReviewRunSubmission(store(), run(), {
    async submit() {
      throw error
    },
    classifyError: (error) => ({ uncertain: false, message: String(error) })
  })
  assert.deepEqual(result, { outcome: 'failed', error })
})
