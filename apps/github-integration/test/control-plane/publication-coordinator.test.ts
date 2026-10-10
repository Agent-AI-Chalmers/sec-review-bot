import assert from 'node:assert/strict'
import test from 'node:test'

import {
  publishReviewRunsOnce,
  withPublicationHeartbeat
} from '../../src/control-plane/publication-coordinator.js'
import { PublicationClaimLostError } from '../../src/control-plane/publication-claim.js'
import type { ControlPlaneClient, PublicationWork } from '../../src/control-plane/client.js'

test('publisher starts no GitHub work when its initial lease renewal fails', async () => {
  let installationLookups = 0
  let completionAttempts = 0
  const work = {
    run_id: 'run-1',
    workflow: 'issue-review',
    publish_context: {},
    runner_status: 'succeeded',
    created_at: '2026-10-07T00:00:00.000Z',
    published_at: null,
    failure_code: null,
    failure_message: null,
    artifact_storage: null,
    workflow_result: {},
    claim_token: 'claim-1'
  } satisfies PublicationWork
  const claimWaits: number[] = []
  const store = {
    claimNextPublication: async (waitMs = 0) => {
      claimWaits.push(waitMs)
      return work
    },
    renewPublicationClaim: async () => {
      throw new Error('Control Plane unavailable')
    },
    publicationHeartbeatIntervalMs: () => 60_000,
    completePublication: async () => {
      completionAttempts += 1
      return true
    },
    failPublication: async () => {
      throw new Error('A lease failure must not be converted into publication failure.')
    },
    connector_id: 'github-app:test'
  } as unknown as ControlPlaneClient
  const app = {
    octokit: {
      rest: {
        apps: {
          getRepoInstallation: async () => {
            installationLookups += 1
            return { data: { id: 1 } }
          }
        }
      }
    }
  }

  await publishReviewRunsOnce({ app: app as never, store })

  // The pass asks Control Plane to hold the claim, so a run that becomes publishable
  // mid-interval is picked up then instead of at the next poll.
  assert.ok((claimWaits[0] ?? 0) > 0, 'a publication pass must ask for a bounded wait')
  assert.equal(installationLookups, 0)
  assert.equal(completionAttempts, 0)
})

test('explicit ownership checks share a failing in-flight heartbeat', async () => {
  let renewals = 0
  let resolveHeartbeat: ((owned: boolean) => void) | undefined
  let observeHeartbeat: (() => void) | undefined
  const heartbeatStarted = new Promise<void>((resolve) => {
    observeHeartbeat = resolve
  })
  const work = {
    run_id: 'run-1',
    workflow: 'issue-review',
    publish_context: {},
    runner_status: 'succeeded',
    created_at: '2026-10-07T00:00:00.000Z',
    published_at: null,
    failure_code: null,
    failure_message: null,
    artifact_storage: null,
    workflow_result: {},
    claim_token: 'claim-1'
  } satisfies PublicationWork
  const store = {
    renewPublicationClaim: async () => {
      renewals += 1
      if (renewals === 1) return true
      observeHeartbeat?.()
      return await new Promise<boolean>((resolve) => {
        resolveHeartbeat = resolve
      })
    },
    publicationHeartbeatIntervalMs: () => 1
  } as unknown as ControlPlaneClient

  await assert.rejects(
    withPublicationHeartbeat(store, work, async (assertOwned) => {
      await heartbeatStarted
      const ownership = assertOwned()
      resolveHeartbeat?.(false)
      await ownership
    }),
    PublicationClaimLostError
  )
  assert.equal(renewals, 2)
})
