import { clearInterval } from 'node:timers'
import type { App } from 'octokit'

import { startReviewRunCoordinatorLoop } from '../control-plane/coordinator.js'
import { splitRepoFullName } from '../github/repository-service.js'
import { handleIssueReviewRun } from '../../reviews/issues/publish.js'
import { handlePullRequestReviewRun } from '../../reviews/pull-requests/publish.js'
import { handleRepositoryReviewRun } from '../../reviews/repositories/publish.js'
import { logError, logInfo, logWarn } from '../../utils/logger.js'
import { classifyPublicationFailure } from './publication-failure.js'
import { reviewRunStore, type PublicationWork, type ReviewRunStore } from './review-store.js'
import type { RunnerRunStatus } from './client.js'

export interface ReviewRunPublisher {
  stop: () => Promise<void>
}
interface Options {
  app: App
  store?: ReviewRunStore
  intervalMs?: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function errorCode(error: unknown): string | null {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : null
}
function pollIntervalMs(): number {
  const parsed = Number.parseInt(
    process.env.CONTROL_PLANE_PUBLICATION_POLL_INTERVAL_MS || '15000',
    10
  )
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000
}

async function installationOctokitForRepo(app: App, repoFullName: string): Promise<unknown> {
  const { owner_login, repo_name } = splitRepoFullName(repoFullName)
  const installation = await app.octokit.rest.apps.getRepoInstallation({
    owner: owner_login,
    repo: repo_name
  })
  return await app.getInstallationOctokit(installation.data.id)
}

async function publishWork(app: App, store: ReviewRunStore, work: PublicationWork): Promise<void> {
  const status: RunnerRunStatus = {
    run_id: work.run_id,
    workflow: work.workflow,
    status: 'succeeded',
    result: work.workflow_result,
    ...(work.artifact_publication === null
      ? {}
      : { artifact_publication: work.artifact_publication })
  }
  const common = {
    run: work,
    status,
    store,
    claim_token: work.claim_token,
    installation_octokit_for_repo: async (repo: string) =>
      await installationOctokitForRepo(app, repo)
  }
  if (work.workflow === 'issue-review') await handleIssueReviewRun(common)
  else if (work.workflow === 'pull-request-review') await handlePullRequestReviewRun(common)
  else await handleRepositoryReviewRun(common)
}

async function withHeartbeat(
  store: ReviewRunStore,
  work: PublicationWork,
  operation: () => Promise<void>
): Promise<boolean> {
  let lost = false
  let active: Promise<void> | null = null
  const renew = async (): Promise<void> => {
    try {
      if (!(await store.renewPublicationClaim(work.run_id, work.claim_token))) lost = true
    } catch (error) {
      logWarn('review_publication_heartbeat_failed', { error, run_id: work.run_id })
    }
  }
  await renew()
  if (lost) return false
  const timer = setInterval(() => {
    if (active === null)
      active = renew().finally(() => {
        active = null
      })
  }, store.publicationHeartbeatIntervalMs())
  timer.unref?.()
  try {
    await operation()
    if (active !== null) await active
    await renew()
    return !lost
  } finally {
    clearInterval(timer)
    if (active !== null) await active
  }
}

/** Claims only terminal work; Runner observation is owned by Control Plane. */
export async function publishReviewRunsOnce({
  app,
  store = reviewRunStore
}: {
  app: App
  store?: ReviewRunStore
}): Promise<void> {
  const work = await store.claimNextPublication()
  if (work === null) return
  try {
    const ownsClaim = await withHeartbeat(
      store,
      work,
      async () => await publishWork(app, store, work)
    )
    if (!ownsClaim || !(await store.completePublication(work.run_id, work.claim_token))) {
      logWarn('review_publication_claim_lost', { run_id: work.run_id, workflow: work.workflow })
      return
    }
    logInfo('review_publication_completed', { run_id: work.run_id, workflow: work.workflow })
  } catch (error) {
    const classification = classifyPublicationFailure(error)
    const committed = await store.failPublication(
      work.run_id,
      work.claim_token,
      {
        code: errorCode(error) ?? classification.code,
        message: errorMessage(error)
      },
      { retry: classification.retry }
    )
    logError('review_publication_failed', {
      error,
      run_id: work.run_id,
      workflow: work.workflow,
      retry: classification.retry,
      claim_committed: committed
    })
  }
}

export function startRunnerRunPublisher({
  app,
  store = reviewRunStore,
  intervalMs = pollIntervalMs()
}: Options): ReviewRunPublisher {
  const loop = startReviewRunCoordinatorLoop({
    intervalMs,
    runOnce: async () => await publishReviewRunsOnce({ app, store }),
    onError: (error) => {
      logError('review_publication_loop_failed', {
        error,
        error_message: errorMessage(error),
        connector_id: store.connector_id
      })
    }
  })
  logInfo('review_publication_loop_started', {
    connector_id: store.connector_id,
    interval_ms: intervalMs
  })
  return loop
}
