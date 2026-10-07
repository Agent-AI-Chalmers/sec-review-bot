import assert from 'node:assert/strict'
import test from 'node:test'

import {
  publishReviewRunsOnce,
  withPublicationHeartbeat
} from '../../src/infrastructure/runner/run-publisher.js'
import { PublicationClaimLostError } from '../../src/infrastructure/runner/publication-claim.js'
import type {
  PublicationWork,
  ReviewRunStore
} from '../../src/infrastructure/runner/review-store.js'

test('publisher starts no GitHub work when its initial lease renewal fails', async () => {
  let installationLookups = 0
  let completionAttempts = 0
  const work = {
    run_id: 'run-1',
    workflow: 'issue-review',
    publish_context: {},
    status: 'publishing',
    created_at: '2026-10-07T00:00:00.000Z',
    updated_at: '2026-10-07T00:00:00.000Z',
    published_at: null,
    failure_code: null,
    failure_message: null,
    artifact_publication: null,
    workflow_result: {},
    claim_token: 'claim-1'
  } satisfies PublicationWork
  const store = {
    claimNextPublication: async () => work,
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
  } as unknown as ReviewRunStore
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
    status: 'publishing',
    created_at: '2026-10-07T00:00:00.000Z',
    updated_at: '2026-10-07T00:00:00.000Z',
    published_at: null,
    failure_code: null,
    failure_message: null,
    artifact_publication: null,
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
  } as unknown as ReviewRunStore

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
