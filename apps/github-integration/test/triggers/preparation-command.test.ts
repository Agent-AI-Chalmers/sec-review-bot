import { inputBundlePublicationStore } from '../input-bundle-publication-store.js'
import { expect, test } from 'vitest'

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
      expect.unreachable('this command must not checkpoint'),
    admitReviewRun: () =>
      expect.unreachable('a claimed retry must not admit again'),
    renewPreparationClaim: async () => true,
    preparationHeartbeatIntervalMs: async () => 60_000,
    submitPreparedRun: () =>
      expect.unreachable('this preparation must not submit'),
    failPreparation: () =>
      expect.unreachable('this owner must not record a failure')
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

  await expect(
    runPreparationCommand({
      store,
      admission,
      claimed_preparation: {
        run_id: 'original-run',
        token: 'retry-token',
        attempt_count: 3
      },
      on_admitted: () => expect.unreachable('a retry is not a fresh admission'),
      publish_context: () =>
        expect.unreachable('ownership must be proven first'),
      prepare_review: async ({ run_id }) => {
        expect(run_id).toBe('original-run')
        throw error
      }
    })
  ).rejects.toSatisfy((caught) => caught === error)

  expect(renewals).toStrictEqual([['original-run', 'retry-token']])
  expect(failures).toStrictEqual([
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

  await expect(
    runPreparationCommand({
      store,
      admission,
      claimed_preparation: { run_id: 'original-run', token: 'expired-token' },
      publish_context: () =>
        expect.unreachable('ownership must be proven first'),
      prepare_review: async () => ({ review: {}, input: {} })
    })
  ).rejects.toThrow(PreparationClaimLostError)
  expect(renewals).toBe(2)
})
