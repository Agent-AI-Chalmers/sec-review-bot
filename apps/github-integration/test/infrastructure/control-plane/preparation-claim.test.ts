import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PreparationClaimLostError,
  startPreparationClaimHeartbeat
} from '../../../src/infrastructure/control-plane/preparation-claim.js'

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
  assert.equal(await heartbeat.stop(), true)
  assert.ok(renewals >= 2)
})

test('preparation heartbeat rejects an already stale owner before work starts', async () => {
  await assert.rejects(
    startPreparationClaimHeartbeat(
      {
        renewPreparationClaim: async () => false,
        preparationHeartbeatIntervalMs: () => 60_000
      },
      'run-1',
      'stale-claim'
    ),
    PreparationClaimLostError
  )
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
  await assert.rejects(heartbeat.assertOwned(), PreparationClaimLostError)
  assert.equal(await heartbeat.stop(), false)
})
