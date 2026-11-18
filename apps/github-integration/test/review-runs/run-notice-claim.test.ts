import { expect, test } from 'vitest'

import {
  RunNoticeClaimLostError,
  startRunNoticeClaimHeartbeat
} from '../../src/review-runs/run-notice-claim.js'

test('run notice heartbeat renews the claim while delivery remains active', async ({
  onTestFinished
}) => {
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

  onTestFinished(async () => {
    await heartbeat.stop()
  })
  await expect.poll(() => renewals, { timeout: 500, interval: 10 }).toBeGreaterThanOrEqual(2)
  expect(await heartbeat.stop()).toBe(true)
  expect.assert(renewals >= 2)
})

test('run notice heartbeat rejects a claim superseded before delivery starts', async () => {
  await expect(
    startRunNoticeClaimHeartbeat(
      {
        renewRunNoticeClaim: async () => false,
        runNoticeHeartbeatIntervalMs: async () => 60_000
      },
      'notice-1',
      'stale-claim'
    )
  ).rejects.toThrow(RunNoticeClaimLostError)
})

test('an unconfirmed run notice renewal revokes permission to write', async () => {
  let reachable = true
  const heartbeat = await startRunNoticeClaimHeartbeat(
    {
      renewRunNoticeClaim: async () => {
        if (!reachable) {
          throw new Error('Review Runs unavailable')
        }
        return true
      },
      runNoticeHeartbeatIntervalMs: async () => 60_000
    },
    'notice-1',
    'claim-1'
  )

  reachable = false
  await expect(heartbeat.assertOwned()).rejects.toThrow(RunNoticeClaimLostError)
  expect(await heartbeat.stop()).toBe(false)
})
