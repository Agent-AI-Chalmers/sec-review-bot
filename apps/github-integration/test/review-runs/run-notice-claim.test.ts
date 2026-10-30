import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RunNoticeClaimLostError,
  startRunNoticeClaimHeartbeat
} from '../../src/review-runs/run-notice-claim.js'

test('run notice heartbeat renews the claim while delivery remains active', async () => {
  let renewals = 0
  const heartbeat = await startRunNoticeClaimHeartbeat(
    {
      renewRunNoticeClaim: async () => {
        renewals += 1
        return true
      },
      runNoticeHeartbeatIntervalMs: async () => 5
    },
    'notice-1',
    'claim-1'
  )

  const deadline = Date.now() + 500
  while (renewals < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.strictEqual(await heartbeat.stop(), true)
  assert.ok(renewals >= 2)
})

test('run notice heartbeat rejects a claim superseded before delivery starts', async () => {
  await assert.rejects(
    startRunNoticeClaimHeartbeat(
      {
        renewRunNoticeClaim: async () => false,
        runNoticeHeartbeatIntervalMs: async () => 60_000
      },
      'notice-1',
      'stale-claim'
    ),
    RunNoticeClaimLostError
  )
})

test('an unconfirmed run notice renewal revokes permission to write', async () => {
  let reachable = true
  const heartbeat = await startRunNoticeClaimHeartbeat(
    {
      renewRunNoticeClaim: async () => {
        if (!reachable) throw new Error('Review Runs unavailable')
        return true
      },
      runNoticeHeartbeatIntervalMs: async () => 60_000
    },
    'notice-1',
    'claim-1'
  )

  reachable = false
  await assert.rejects(heartbeat.assertOwned(), RunNoticeClaimLostError)
  assert.strictEqual(await heartbeat.stop(), false)
})
