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
import { fakeGitHub, githubJson } from '../github-client.js'
import { settleExhaustedStep } from '../../src/reviews/shared/settle-exhausted-step.js'
import { RUNNER_PUBLISH_ERROR_CODES } from '../../src/runner/publish-error-code.js'
import { CONTRACT_VERSION } from '../../src/runner/contract-version.js'

const RUN_ID = '6f1c2f9e-0000-4000-8000-000000000001'

/** The publish context a repository scan persists; the publish path parses it before any
 * GitHub call, so a test that reaches reconciliation has to supply a valid one. */
const REPOSITORY_CONTEXT = {
  repo: {
    owner_login: 'octo',
    repo_name: 'example',
    repo_full_name: 'octo/example',
    default_branch: 'main'
  },
  workspace_ref: 'workspace-sha',
  scan_target: {
    target_branch: 'main',
    scan_mode: 'full',
    base_sha: null,
    head_sha: 'head-sha'
  },
  event_type: 'manual'
}

/** An installation-scoped client whose transport answers nothing but empty lists.
 *
 * The repository publish path only reaches reconciliation once its GitHub lookups succeed, so a
 * test of that path needs a client rather than a missing installation.
 */
function fakeInstallationOctokit() {
  const { octokit } = fakeGitHub(({ method, url }) => {
    const pathname = new URL(url).pathname
    if (method === 'GET') return githubJson([])
    if (pathname.endsWith('/issues'))
      return githubJson({ number: 11, html_url: 'https://example.test/i/11' })
    return githubJson({})
  })
  return octokit
}

/** A scan with no deliveries or cases: enough to publish the summary issue and comment. */
const EMPTY_REPOSITORY_RESULT = {
  contract_version: CONTRACT_VERSION,
  scan_summary: {
    scannable_file_count: 0,
    scanned_file_count: 0,
    skipped_file_count: 0,
    candidate_count: 0,
    case_count: 0,
    suppressed_candidate_count: 0,
    deleted_file_count: 0
  },
  deliveries: [],
  case_results: [],
  deletion_review_skipped: false
}

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
  | 'settleExhaustedPublicationStep'
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
    settleExhaustedPublicationStep: async () =>
      unreached('settleExhaustedPublicationStep'),
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
      disconnect_reason: null
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
      disconnect_reason: null
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

test('a reconciliation that loses the step ends the publication instead of holding its lease', async () => {
  // The exhausted-step path looks for the remote effect, then asks Control Plane to settle the
  // step. When another owner moved the step first the write is refused, and the connector
  // reports the original exhaustion error. What must not happen is the publication sitting on
  // that error without concluding anything: the claim would only be resolved when its lease
  // expires, and the step would stay `uncertain` with no owner. The coordinator classifies the
  // error as terminal and records it, which releases the claim so the next owner re-reads the
  // step.
  const lost = await settleExhaustedStep({
    store: {
      settleExhaustedPublicationStep: async () => false
    } as unknown as Parameters<typeof settleExhaustedStep>[0]['store'],
    runId: 'run-1',
    token: 'claim-1',
    stepKey: 'repository:summary-issue',
    find: async () => null
  })
  assert.deepStrictEqual(lost, { outcome: 'not_owned' })

  const failures: Array<{
    code: string | null | undefined
    retry: boolean | undefined
  }> = []
  let settlementAttempts = 0
  const store = {
    claimNextPublication: async () =>
      ({
        run_id: RUN_ID,
        workflow: 'repository-review',
        publish_context: REPOSITORY_CONTEXT,
        preparation: {
          status: 'submitted',
          attempt_count: 1,
          started_at: '2026-01-01T00:00:01.000Z',
          finished_at: '2026-01-01T00:00:02.000Z',
          updated_at: '2026-01-01T00:00:03.000Z',
          failure_code: null,
          disconnect_reason: null
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
        workflow_result: EMPTY_REPOSITORY_RESULT,
        claim_token: 'claim-1'
      }) satisfies PublicationWork,
    renewPublicationClaim: async () => true,
    publicationHeartbeatIntervalMs: async () => 60_000,
    completePublication: async () => false,
    failPublication: async (
      _runId: string,
      _token: string,
      error: { code?: string | null; message: string },
      options: { retry?: boolean } = {}
    ) => {
      failures.push({ code: error.code, retry: options.retry })
      return true
    },
    initializePublicationSteps: async () => {},
    // The two summary steps the repository path claims; neither has succeeded, so both are
    // candidates and the first one is the step this test exercises.
    listPublicationSteps: async () =>
      ['repository:summary-issue', 'repository:summary-comment'].map(
        (step_key) => ({
          step_key,
          status: 'pending' as const,
          attempt_count: 3,
          last_attempt_at: null,
          remote_object_id: null,
          remote_object_url: null,
          failure_code: null,
          failure_message: null
        })
      ),
    // The publish path reaches the claim first; refusing it with the exhaustion code is what
    // enters reconciliation, and the reconciliation then loses the settlement. Control Plane
    // answers a refusal with a 409, which is what tells this code apart from the same code on a
    // request that never reached it.
    requirePublicationStepClaim: async () => {
      throw Object.assign(new Error('no attempts left'), {
        code: RUNNER_PUBLISH_ERROR_CODES.publication_step_retry_exhausted,
        status: 409
      })
    },
    completePublicationStep: async () => true,
    settleExhaustedPublicationStep: async () => {
      settlementAttempts += 1
      return false
    },
    failPublicationStep: async () => true
  } as unknown as PublicationCoordinatorStore
  // A real installation client, so every GitHub call the publish path makes is recorded rather
  // than treated as a missing installation. Answers are empty by design: nothing is on the
  // remote system, which is the case in which reconciliation reports `absent`.
  const { app } = fakeApp({
    respond: () => githubJson({ id: 1 }),
    installationOctokit: fakeInstallationOctokit()
  })

  await publishReviewRunsOnce({ app, store })

  assert.strictEqual(settlementAttempts, 1, 'the step was reconciled once')
  assert.deepStrictEqual(
    failures,
    [
      {
        code: RUNNER_PUBLISH_ERROR_CODES.publication_step_retry_exhausted,
        retry: false
      }
    ],
    'a lost reconciliation is recorded as a terminal failure, which releases the claim'
  )
})
