import { inputBundlePublicationStore } from '../input-bundle-publication-store.js'
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  runPreparationCommand,
  type PreparationCommandStore
} from '../../src/triggers/preparation-command.js'
import { PreparationClaimLostError } from '../../src/review-runs/preparation-claim.js'

const admission = {
  workflow: 'issue-review' as const,
  ingress_key: 'original-delivery',
  preparation_input: {}
}

function claimedStore(): PreparationCommandStore {
  return {
    ...inputBundlePublicationStore(),
    checkpointPreparationInput: async () =>
      assert.fail('this command must not checkpoint'),
    admitReviewRun: () => assert.fail('a claimed retry must not admit again'),
    renewPreparationClaim: async () => true,
    preparationHeartbeatIntervalMs: async () => 60_000,
    submitPreparedRun: () => assert.fail('this preparation must not submit'),
    failPreparation: () => assert.fail('this owner must not record a failure')
  }
}

test('claimed preparation retains its run, fencing token, and retry budget', async () => {
  const failures: unknown[][] = []
  const renewals: unknown[][] = []
  const error = new Error('temporary upstream failure')
  const store = claimedStore()
  store.renewPreparationClaim = async (...args) => {
    renewals.push(args)
    return true
  }
  store.failPreparation = (...args) => {
    failures.push(args)
  }

  await assert.rejects(
    runPreparationCommand({
      store,
      admission,
      claimed_preparation: {
        run_id: 'original-run',
        token: 'retry-token',
        attempt_count: 3
      },
      on_admitted: () => assert.fail('a retry is not a fresh admission'),
      publish_context: () => assert.fail('ownership must be proven first'),
      prepare_review: async ({ run_id }) => {
        assert.equal(run_id, 'original-run')
        throw error
      }
    }),
    (caught) => caught === error
  )

  assert.deepEqual(renewals, [['original-run', 'retry-token']])
  assert.deepEqual(failures, [
    [
      'original-run',
      'retry-token',
      { code: 'REVIEW_START_FAILED', message: error.message },
      { retry: true, retryAfterMs: 20_000 }
    ]
  ])
})

test('claim loss immediately before submission leaves the new owner responsible', async () => {
  const store = claimedStore()
  let renewals = 0
  store.renewPreparationClaim = async () => ++renewals === 1

  await assert.rejects(
    runPreparationCommand({
      store,
      admission,
      claimed_preparation: { run_id: 'original-run', token: 'expired-token' },
      publish_context: () => assert.fail('ownership must be proven first'),
      prepare_review: async () => ({ review: {}, input: {} })
    }),
    PreparationClaimLostError
  )
  assert.equal(renewals, 2)
})
