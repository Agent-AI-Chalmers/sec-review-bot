import assert from 'node:assert/strict'
import test from 'node:test'

import {
  publishReviewRunsOnce,
  withPublicationHeartbeat
} from '../../src/control-plane/publication-coordinator.js'
import { PublicationClaimLostError } from '../../src/control-plane/publication-claim.js'
import type {
  PublicationCoordinatorStore,
  PublicationHeartbeatStore,
  PublicationWork
} from '../../src/control-plane/client.js'
import { fakeApp } from '../github-app-stubs.js'
import { githubJson } from '../github-client.js'

/**
 * The publication-step members `publishReviewRunsOnce` may reach but a lease-failure test never
 * triggers. They fail loudly if that path is entered, which is clearer than a silent stub.
 */
function unreachedPublicationSteps(): Pick<
  PublicationCoordinatorStore,
  | 'initializePublicationSteps'
  | 'listPublicationSteps'
  | 'requirePublicationStepClaim'
  | 'completePublicationStep'
  | 'failPublicationStep'
> {
  const unreached = (name: string): never => {
    throw new Error(`the ${name} step should not be reached in this test`)
  }
  return {
    initializePublicationSteps: async () =>
      unreached('initializePublicationSteps'),
    listPublicationSteps: async () => unreached('listPublicationSteps'),
    requirePublicationStepClaim: async () =>
      unreached('requirePublicationStepClaim'),
    completePublicationStep: async () => unreached('completePublicationStep'),
    failPublicationStep: async () => unreached('failPublicationStep')
  }
}

test('publisher starts no GitHub work when its initial lease renewal fails', async () => {
  let installationLookups = 0
  let completionAttempts = 0
  const work = {
    run_id: 'run-1',
    workflow: 'issue-review',
    publish_context: {},
    preparation: {
      status: 'submitted',
      attempt_count: 1,
      started_at: '2026-01-01T00:00:01.000Z',
      finished_at: '2026-01-01T00:00:02.000Z',
      updated_at: '2026-01-01T00:00:03.000Z',
      failure_code: null,
      expiry_blocked_reason: null
    },
    execution: {
      status: 'succeeded',
      started_at: null,
      finished_at: null,
      updated_at: '2026-01-01T00:00:00.000Z'
    },
    publication: {
      status: 'publishing',
      started_at: null,
      finished_at: null,
      updated_at: '2026-01-01T00:00:00.000Z'
    },
    created_at: '2026-10-07T00:00:00.000Z',
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
    publicationHeartbeatIntervalMs: async () => 60_000,
    completePublication: async () => {
      completionAttempts += 1
      return true
    },
    failPublication: async () => {
      throw new Error(
        'A lease failure must not be converted into publication failure.'
      )
    },
    connectorId: 'github-app:test',
    ...unreachedPublicationSteps()
  } satisfies PublicationCoordinatorStore
  const { app, requests } = fakeApp({
    respond: () => {
      installationLookups += 1
      return githubJson({ id: 1 })
    }
  })

  await publishReviewRunsOnce({ app, store })

  // The pass asks Control Plane to hold the claim, so a run that becomes publishable
  // mid-interval is picked up then instead of at the next poll.
  assert.ok(
    (claimWaits[0] ?? 0) > 0,
    'a publication pass must ask for a bounded wait'
  )
  assert.strictEqual(installationLookups, 0)
  assert.strictEqual(completionAttempts, 0)
  // Nothing was asked of GitHub at all: a failed lease renewal stops the pass before any lookup.
  assert.deepStrictEqual(requests, [])
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
    preparation: {
      status: 'submitted',
      attempt_count: 1,
      started_at: '2026-01-01T00:00:01.000Z',
      finished_at: '2026-01-01T00:00:02.000Z',
      updated_at: '2026-01-01T00:00:03.000Z',
      failure_code: null,
      expiry_blocked_reason: null
    },
    execution: {
      status: 'succeeded',
      started_at: null,
      finished_at: null,
      updated_at: '2026-01-01T00:00:00.000Z'
    },
    publication: {
      status: 'publishing',
      started_at: null,
      finished_at: null,
      updated_at: '2026-01-01T00:00:00.000Z'
    },
    created_at: '2026-10-07T00:00:00.000Z',
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
    publicationHeartbeatIntervalMs: async () => 1
  } satisfies PublicationHeartbeatStore

  await assert.rejects(
    withPublicationHeartbeat(store, work, async (assertOwned) => {
      await heartbeatStarted
      const ownership = assertOwned()
      resolveHeartbeat?.(false)
      await ownership
    }),
    PublicationClaimLostError
  )
  assert.strictEqual(renewals, 2)
})
