import { expect, test } from 'vitest'

import {
  PreparationClaimLostError,
  startPreparationClaimHeartbeat
} from '../../src/review-runs/preparation-claim.js'

test('preparation heartbeat renews the claim while work remains active', async () => {
  let renewals = 0
  const heartbeat = await startPreparationClaimHeartbeat(
    {
      renewPreparationClaim: async () => {
        renewals += 1
        return true
      },
      preparationHeartbeatIntervalMs: () => 5
    },
    'run-1',
    'claim-1'
  )

  const deadline = Date.now() + 500
  while (renewals < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(await heartbeat.stop()).toBe(true)
  expect.assert(renewals >= 2)
})

test('preparation heartbeat rejects an already stale owner before work starts', async () => {
  await expect(
    startPreparationClaimHeartbeat(
      {
        renewPreparationClaim: async () => false,
        preparationHeartbeatIntervalMs: () => 60_000
      },
      'run-1',
      'stale-claim'
    )
  ).rejects.toThrow(PreparationClaimLostError)
})

test('preparation heartbeat fences active work when its claim is lost', async () => {
  let current = true
  const heartbeat = await startPreparationClaimHeartbeat(
    {
      renewPreparationClaim: async () => current,
      preparationHeartbeatIntervalMs: () => 60_000
    },
    'run-1',
    'claim-1'
  )

  current = false
  await expect(heartbeat.assertOwned()).rejects.toThrow(
    PreparationClaimLostError
  )
  expect(await heartbeat.stop()).toBe(false)
})

test('a transport failure during renewal blocks further work but does not claim the lease was lost', async () => {
  // Unlike a `false` renewal, a thrown one does not prove another owner took the work: Review
  // Runs may simply have been unreachable. Work must not continue on an unconfirmed lease, so
  // `assertOwned` rejects. `stop()` still reports the claim as possibly held so the caller can
  // record the failure, and Review Runs fences that report by token if ownership did move.
  let reachable = true
  const heartbeat = await startPreparationClaimHeartbeat(
    {
      renewPreparationClaim: async () => {
        if (!reachable) throw new Error('connect ECONNREFUSED')
        return true
      },
      preparationHeartbeatIntervalMs: () => 60_000
    },
    'run-1',
    'claim-1'
  )

  reachable = false
  await expect(heartbeat.assertOwned()).rejects.toThrow(/ECONNREFUSED/)
  expect(await heartbeat.stop()).toBe(true)
})
