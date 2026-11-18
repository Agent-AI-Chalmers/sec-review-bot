import { clearImmediate, clearInterval } from 'node:timers'
import type { App } from 'octokit'

import { handleIssueReviewRun } from '../reviews/issues/publish.js'
import { handlePullRequestReviewRun } from '../reviews/pull-requests/publish.js'
import { handleRepositoryReviewRun } from '../reviews/repositories/publish.js'
import { integerEnv } from '../utils/env.js'
import { logError, logInfo, logWarn } from '../utils/logger.js'
import { asErrorMessage, errorCode } from '../utils/error-utils.js'
import { classifyPublicationFailure } from './publication-failure.js'
import {
  isPublicationClaimLostError,
  PublicationClaimLostError
} from './publication-claim.js'
import {
  reviewRunsClient,
  type PublicationCoordinatorStore,
  type PublicationHeartbeatStore,
  type PublicationWork
} from './client.js'
import { installationOctokitForRepo } from '../github/installation-client.js'

export interface PublicationCoordinator {
  stop: () => Promise<void>
}

interface Options {
  app: App
  store?: PublicationCoordinatorStore
  intervalMs?: number
}

function pollIntervalMs(): number {
  return integerEnv('REVIEW_RUNS_PUBLICATION_POLL_INTERVAL_MS', 15_000)
}

async function publishWork(
  app: App,
  store: PublicationCoordinatorStore,
  work: PublicationWork,
  assertOwned: () => Promise<void>
): Promise<void> {
  const common = {
    run: work,
    result: work.workflow_result,
    store,
    claim_token: work.claim_token,
    assert_publication_claim: assertOwned,
    installation_octokit_for_repo: async (repo: string) =>
      await installationOctokitForRepo(app, repo)
  }
  if (work.workflow === 'issue-review') await handleIssueReviewRun(common)
  else if (work.workflow === 'pull-request-review')
    await handlePullRequestReviewRun(common)
  else await handleRepositoryReviewRun(common)
}

export async function withPublicationHeartbeat(
  store: PublicationHeartbeatStore,
  work: PublicationWork,
  operation: (assertOwned: () => Promise<void>) => Promise<void>
): Promise<boolean> {
  let lost = false
  let active: Promise<void> | null = null
  const renew = async (): Promise<void> => {
    try {
      if (!(await store.renewPublicationClaim(work.run_id, work.claim_token))) {
        lost = true
        throw new PublicationClaimLostError(work.run_id)
      }
    } catch (error) {
      lost = true
      logWarn('review_publication_heartbeat_failed', {
        error,
        run_id: work.run_id
      })
      throw error instanceof PublicationClaimLostError
        ? error
        : new PublicationClaimLostError(work.run_id, { cause: error })
    }
  }
  const renewSerially = async (): Promise<void> => {
    // Lease ownership is monotonic within one publication attempt. A later
    // successful renewal cannot make work started during an uncertain interval safe.
    if (lost) throw new PublicationClaimLostError(work.run_id)
    active ??= renew().finally(() => {
      active = null
    })
    await active
    if (lost) throw new PublicationClaimLostError(work.run_id)
  }
  try {
    await renewSerially()
  } catch {
    return false
  }
  const intervalMs = await store.publicationHeartbeatIntervalMs()
  const timer = setInterval(() => {
    void renewSerially().catch(() => undefined)
  }, intervalMs)
  timer.unref?.()
  // The timer and operation can assign active; TypeScript cannot see those callback writes.
  try {
    await operation(renewSerially)
    if (active !== null) await (active as Promise<void>)
    try {
      await renewSerially()
    } catch {
      return false
    }
    return !lost
  } finally {
    clearInterval(timer)
    if (active !== null) await (active as Promise<void>)
  }
}

/** The steps that kept the publication from completing, for its failure message. A step skipped
 * without a claim (a delivery whose reconciliation got a 404) has no failure of its own on record,
 * so this is where the run says which one. Falls back to the generic sentence if unreadable. */
async function incompleteStepsMessage(
  store: PublicationCoordinatorStore,
  runId: string
): Promise<string> {
  const generic = 'Publication completed without all required steps succeeding.'
  try {
    const unsettled = (await store.listPublicationSteps(runId)).filter(
      (step) => step.status !== 'succeeded'
    )
    if (unsettled.length === 0) return generic
    const described = unsettled.map(
      (step) =>
        `${step.step_key} (${step.status}${step.failure_code === null ? '' : `, ${step.failure_code}`})`
    )
    return `${generic} Not succeeded: ${described.join('; ')}.`
  } catch (error) {
    logWarn('review_publication_incomplete_steps_unavailable', {
      error,
      run_id: runId
    })
    return generic
  }
}

/** Claims only terminal work; Execution Gateway observation is owned by Review Runs. */
export async function publishReviewRunsOnce({
  app,
  store = reviewRunsClient
}: {
  app: App
  store?: PublicationCoordinatorStore
}): Promise<void> {
  // Hold the claim briefly rather than returning immediately: a run that becomes
  // publishable mid-interval is picked up as soon as it does, and the poll timer above
  // stays as the backstop. The wait stays comfortably inside the client's request
  // timeout.
  const work = await store.claimNextPublication(
    Math.min(pollIntervalMs(), 10_000)
  )
  if (work === null) return
  try {
    const ownsClaim = await withPublicationHeartbeat(
      store,
      work,
      async (assertOwned) => await publishWork(app, store, work, assertOwned)
    )
    if (!ownsClaim) {
      logWarn('review_publication_claim_lost', {
        run_id: work.run_id,
        workflow: work.workflow
      })
      return
    }
    if (!(await store.completePublication(work.run_id, work.claim_token))) {
      const committed = await store.failPublication(
        work.run_id,
        work.claim_token,
        {
          code: 'PUBLICATION_STEPS_INCOMPLETE',
          message: await incompleteStepsMessage(store, work.run_id)
        },
        { retry: false }
      )
      if (!committed) await logRefusedConclusion(store, work)
      else
        logError('review_publication_failed', {
          run_id: work.run_id,
          workflow: work.workflow,
          retry: false
        })
      return
    }
    logInfo('review_publication_completed', {
      run_id: work.run_id,
      workflow: work.workflow
    })
  } catch (error) {
    if (isPublicationClaimLostError(error)) {
      // Ownership is unknown, so neither success nor failure may be committed.
      // The lease timeout is the only authority allowed to hand work to a new owner.
      logWarn('review_publication_claim_lost', {
        run_id: work.run_id,
        workflow: work.workflow
      })
      return
    }
    const classification = classifyPublicationFailure(error)
    const committed = await store.failPublication(
      work.run_id,
      work.claim_token,
      {
        code: errorCode(error) ?? classification.code,
        message: asErrorMessage(error)
      },
      { retry: classification.retry }
    )
    // The publish error is logged whether or not its failure could be recorded: it is the
    // diagnosis, and a refused conclusion explains only why the run did not change.
    logError('review_publication_failed', {
      error,
      run_id: work.run_id,
      workflow: work.workflow,
      retry: classification.retry
    })
    if (!committed) await logRefusedConclusion(store, work)
  }
}

/** Log why Review Runs refused to conclude: a parked step means the run was handed to an operator,
 * otherwise the claim is presumed lost. This is inferred from the steps after the refusal, not
 * confirmed; a parked run cannot be claimed again, so the two are not expected together. */
async function logRefusedConclusion(
  store: PublicationCoordinatorStore,
  work: PublicationWork
): Promise<void> {
  let parked: string[] = []
  try {
    parked = (await store.listPublicationSteps(work.run_id))
      .filter((step) => step.status === 'disconnected')
      .map((step) => step.step_key)
  } catch (error) {
    logWarn('review_publication_refusal_unexplained', {
      error,
      run_id: work.run_id,
      workflow: work.workflow
    })
  }
  if (parked.length > 0) {
    logInfo('review_publication_left_for_operator', {
      run_id: work.run_id,
      workflow: work.workflow,
      parked_steps: parked.join(',')
    })
    return
  }
  logWarn('review_publication_claim_lost', {
    run_id: work.run_id,
    workflow: work.workflow
  })
}

export function startPublicationCoordinator({
  app,
  store = reviewRunsClient,
  intervalMs = pollIntervalMs()
}: Options): PublicationCoordinator {
  // A connector may hold only one publication pass at a time. Shutdown prevents new ticks
  // and waits for the active pass before returning.
  let stopped = false
  let active: Promise<void> | null = null
  const run = (): void => {
    if (stopped || active !== null) return
    active = publishReviewRunsOnce({ app, store })
      .catch((error) => {
        logError('review_publication_loop_failed', {
          error,
          error_message: asErrorMessage(error),
          connector_id: store.connectorId
        })
      })
      .finally(() => {
        active = null
      })
  }

  const timer = setInterval(run, intervalMs)
  timer.unref?.()
  const initialRun = setImmediate(run)
  logInfo('review_publication_loop_started', {
    connector_id: store.connectorId,
    interval_ms: intervalMs
  })
  return {
    stop: async () => {
      stopped = true
      clearImmediate(initialRun)
      clearInterval(timer)
      await active
    }
  }
}
