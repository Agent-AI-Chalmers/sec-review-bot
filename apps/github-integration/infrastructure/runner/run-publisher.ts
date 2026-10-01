import type { App } from 'octokit'
import { clearImmediate, clearInterval } from 'node:timers'

import {
  completedRunnerRunResult,
  getRunnerRunStatus,
  RUNNER_RUN_NOT_FOUND,
  RunnerSubmissionUncertainError,
  submitRunnerRun,
  type RunnerRunStatus
} from './client.js'
import {
  reviewRunStore,
  type ReviewRunRecord,
  type ReviewRunStore
} from './review-store.js'
import { splitRepoFullName } from '../github/repository-service.js'
import { handleIssueReviewRun } from '../../reviews/issues/publish.js'
import { handlePullRequestReviewRun } from '../../reviews/pull-requests/publish.js'
import { handleRepositoryReviewRun } from '../../reviews/repositories/publish.js'
import { logError, logInfo, logWarn } from '../../utils/logger.js'
import { classifyPublicationFailure } from './publication-failure.js'

type JsonObject = Record<string, unknown>

interface ReviewRunPublisherOptions {
  app: App
  store?: ReviewRunStore
  intervalMs?: number
  get_runner_run_status?: GetRunnerRunStatus
  submit_runner_run?: SubmitRunnerRun
}

type GetRunnerRunStatus = typeof getRunnerRunStatus
type SubmitRunnerRun = typeof submitRunnerRun

export interface ReviewRunPublisher {
  stop: () => Promise<void>
}

type InstallationOctokitForRepo = (repo_full_name: string) => Promise<unknown>

type RunPublishHandler = (args: {
  run: ReviewRunRecord
  status: RunnerRunStatus
  store: ReviewRunStore
  claim_token: string
  installation_octokit_for_repo: InstallationOctokitForRepo
}) => Promise<void>

function parsePositiveIntegerEnv (name: string, fallback: number): number {
  const value = process.env[name]
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function pollIntervalMs (): number {
  return parsePositiveIntegerEnv('AGENT_RUNNER_BACKGROUND_POLL_INTERVAL_MS', 15_000)
}

function isRecord (value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asErrorMessage (error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function asErrorCode (error: unknown): string | null {
  if (isRecord(error) && typeof error.code === 'string') {
    return error.code
  }
  return null
}

function isTerminalRunnerPollingError (error: unknown): boolean {
  if (!isRecord(error) || error.name !== 'AgentRunnerServiceError') return false
  return error.retryable === false || error.code === RUNNER_RUN_NOT_FOUND
}

// Runner publication happens after the original webhook/dispatch call has ended.
// The installation-scoped Octokit from that call cannot be persisted in publish_context,
// so the publisher rebuilds a fresh client from the repository identity before publishing.
async function installation_octokit_for_repo ({ app, repo_full_name }: { app: App, repo_full_name: string }): Promise<unknown> {
  const { owner_login, repo_name } = splitRepoFullName(repo_full_name)
  const installation = await app.octokit.rest.apps.getRepoInstallation({
    owner: owner_login,
    repo: repo_name
  })
  return await app.getInstallationOctokit(installation.data.id)
}

async function handleWorkflowRun ({
  app,
  run,
  status,
  store,
  claim_token
}: {
  app: App
  run: ReviewRunRecord
  status: RunnerRunStatus
  store: ReviewRunStore
  claim_token: string
}): Promise<void> {
  const handlers: Record<string, RunPublishHandler> = {
    'issue-review': handleIssueReviewRun,
    'pull-request-review': handlePullRequestReviewRun,
    'repository-review': handleRepositoryReviewRun
  }
  const handler = handlers[run.workflow]
  if (!handler) {
    throw new Error(`No completed run handler registered for workflow: ${run.workflow}`)
  }

  await handler({
    run,
    status,
    store,
    claim_token,
    installation_octokit_for_repo: async (repo_full_name) => installation_octokit_for_repo({
      app,
      repo_full_name
    })
  })
}

async function runWithPublicationHeartbeat ({
  store,
  run,
  claim_token,
  operation
}: {
  store: ReviewRunStore
  run: ReviewRunRecord
  claim_token: string
  operation: () => Promise<void>
}): Promise<boolean> {
  let claimLost = false
  let renewal: Promise<void> | null = null
  const renew = async (): Promise<void> => {
    try {
      if (!await store.renewPublicationClaim(run.run_id, claim_token)) claimLost = true
    } catch (error) {
      // A transient database outage does not prove ownership was lost. The last
      // successful heartbeat still prevents takeover until its lease expires.
      logWarn('runner_run_publish_heartbeat_failed', {
        error,
        error_message: asErrorMessage(error),
        run_id: run.run_id,
        workflow: run.workflow
      })
    }
  }

  await renew()
  if (claimLost) return false
  const timer = setInterval(() => {
    if (renewal !== null) return
    renewal = renew().finally(() => { renewal = null })
  }, store.publicationHeartbeatIntervalMs())
  timer.unref?.()
  try {
    await operation()
    if (renewal !== null) await renewal
    await renew()
    return !claimLost
  } finally {
    clearInterval(timer)
    if (renewal !== null) await renewal
  }
}

async function publishCompletedRun ({
  app,
  store,
  run,
  get_runner_run_status = getRunnerRunStatus
}: {
  app: App
  store: ReviewRunStore
  run: ReviewRunRecord
  get_runner_run_status?: GetRunnerRunStatus
}): Promise<void> {
  let status: RunnerRunStatus
  try {
    status = await get_runner_run_status({ run_id: run.run_id })
  } catch (error) {
    if (isTerminalRunnerPollingError(error)) {
      await store.failRunnerExecution(run.run_id, {
        code: asErrorCode(error) ?? 'RUNNER_STATUS_POLL_FAILED',
        message: asErrorMessage(error)
      })
      logError('runner_run_status_poll_terminal_failure', {
        error,
        error_message: asErrorMessage(error),
        run_id: run.run_id,
        workflow: run.workflow
      })
      return
    }
    // A transient polling outage has no GitHub side effect and spends no
    // publication attempt. The active run is retried on the next tick.
    logWarn('runner_run_status_poll_failed', {
      error,
      error_message: asErrorMessage(error),
      run_id: run.run_id,
      workflow: run.workflow
    })
    return
  }
  if (status.status !== 'succeeded' && status.status !== 'failed') {
    if (status.status === 'running' && run.status === 'queued') {
      await store.markRunning(run.run_id)
    }
    return
  }

  if (status.status === 'failed') {
    let error: unknown
    try {
      // Normalize the terminal Runner response without entering GitHub
      // publication. Runner execution and publication have different owners.
      completedRunnerRunResult(status)
      error = new Error(`Runner run failed without an error: ${run.run_id}`)
    } catch (runnerError) {
      error = runnerError
    }
    await store.failRunnerExecution(run.run_id, {
      code: asErrorCode(error) ?? 'RUNNER_EXECUTION_FAILED',
      message: asErrorMessage(error)
    })
    logError('runner_run_failed', {
      error,
      error_message: asErrorMessage(error),
      failure_code: asErrorCode(error) ?? 'RUNNER_EXECUTION_FAILED',
      run_id: run.run_id,
      workflow: run.workflow
    })
    return
  }

  const claimToken = await store.claimPublication(run.run_id)
  if (claimToken === null) {
    logInfo('runner_run_publish_claim_skipped', {
      run_id: run.run_id,
      workflow: run.workflow
    })
    return
  }
  try {
    const stillOwnsClaim = await runWithPublicationHeartbeat({
      store,
      run,
      claim_token: claimToken,
      operation: async () => await handleWorkflowRun({ app, run, status, store, claim_token: claimToken })
    })
    if (!stillOwnsClaim) {
      logWarn('runner_run_publish_claim_lost', {
        attempted_state: 'published',
        run_id: run.run_id,
        workflow: run.workflow
      })
      return
    }
    const committed = await store.completePublication(run.run_id, claimToken)
    if (!committed) {
      // The remote call may have completed after this claim expired. The new
      // owner now decides the durable state; this stale owner must stay silent.
      logWarn('runner_run_publish_claim_lost', {
        attempted_state: 'published',
        run_id: run.run_id,
        workflow: run.workflow
      })
      return
    }
    logInfo('runner_run_publish_completed', {
      run_id: run.run_id,
      workflow: run.workflow
    })
  } catch (error) {
    const message = asErrorMessage(error)
    const classification = classifyPublicationFailure(error)
    const code = asErrorCode(error) ?? classification.code
    const committed = await store.failPublication(
      run.run_id,
      claimToken,
      { code, message },
      { retry: classification.retry }
    )
    if (!committed) {
      logWarn('runner_run_publish_claim_lost', {
        attempted_state: classification.retry ? 'pending' : 'failed',
        run_id: run.run_id,
        workflow: run.workflow
      })
      return
    }
    const updatedRun = await store.getRun(run.run_id)
    logError('runner_run_publish_failed', {
      diagnostic_state: classification.reason,
      error,
      error_message: message,
      failure_code: code,
      retry: classification.retry,
      run_id: run.run_id,
      status_after: updatedRun?.status ?? null,
      status_before: run.status,
      workflow: run.workflow
    })
  }
}

async function recoverSubmission ({
  store,
  run,
  submit_runner_run
}: {
  store: ReviewRunStore
  run: ReviewRunRecord
  submit_runner_run: SubmitRunnerRun
}): Promise<void> {
  const claimToken = await store.claimSubmissionRecovery(run.run_id)
  if (claimToken === null) {
    return
  }

  if (run.runner_input === undefined) {
    await store.failSubmissionRecovery(run.run_id, claimToken, {
      code: 'SUBMISSION_RECOVERY_INPUT_MISSING',
      message: 'The persisted Runner input is missing; this submission cannot be recovered.'
    })
    return
  }

  try {
    // Runner treats the same run ID and request as the same submission. Replaying
    // the persisted POST therefore recovers both accepted and missing runs.
    await submit_runner_run({
      workflow: run.workflow,
      run_id: run.run_id,
      input: run.runner_input
    })
    if (!await store.completeSubmissionRecovery(run.run_id, claimToken)) {
      return
    }
    logInfo('runner_submission_recovered', {
      resolution: 'idempotent-submission-replayed',
      run_id: run.run_id,
      workflow: run.workflow
    })
  } catch (error) {
    const deferred = error instanceof RunnerSubmissionUncertainError
    await store.failSubmissionRecovery(run.run_id, claimToken, {
      code: error instanceof RunnerSubmissionUncertainError
        ? 'SUBMISSION_STATE_UNCERTAIN'
        : asErrorCode(error) ?? 'REVIEW_START_FAILED',
      message: asErrorMessage(error)
    })
    if (deferred) {
      logWarn('runner_submission_recovery_deferred', {
        error,
        error_message: asErrorMessage(error),
        run_id: run.run_id,
        workflow: run.workflow
      })
    }
  }
}

export async function publishReviewRunsOnce ({
  app,
  store = reviewRunStore,
  get_runner_run_status = getRunnerRunStatus,
  submit_runner_run = submitRunnerRun
}: {
  app: App
  store?: ReviewRunStore
  get_runner_run_status?: GetRunnerRunStatus
  submit_runner_run?: SubmitRunnerRun
}): Promise<void> {
  await store.expireStalePreparations()

  for (const run of await store.listSubmissionRecoveries()) {
    await recoverSubmission({ store, run, submit_runner_run })
  }

  for (const run of await store.listActiveRuns()) {
    await publishCompletedRun({ app, store, run, get_runner_run_status })
  }
}

export function startRunnerRunPublisher ({
  app,
  store = reviewRunStore,
  intervalMs = pollIntervalMs(),
  get_runner_run_status = getRunnerRunStatus,
  submit_runner_run = submitRunnerRun
}: ReviewRunPublisherOptions): ReviewRunPublisher {
  let stopped = false
  let active: Promise<void> | null = null
  const tick = (): void => {
    if (stopped || active !== null) {
      return
    }
    active = publishReviewRunsOnce({ app, store, get_runner_run_status, submit_runner_run })
      .catch((error: unknown) => {
        logError('runner_run_publisher_failed', {
          error,
          error_message: asErrorMessage(error)
        })
      })
      .finally(() => {
        active = null
      })
  }

  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  const initialTick = setImmediate(tick)
  logInfo('runner_run_publisher_started', {
    interval_ms: intervalMs
  })
  return {
    stop: async () => {
      stopped = true
      clearImmediate(initialTick)
      clearInterval(timer)
      await active
    }
  }
}
