import type { App } from 'octokit'
import { coordinateReviewRunsOnce, startReviewRunCoordinatorLoop } from '../control-plane/coordinator.js'
import { coordinateTerminalRun } from '../control-plane/terminal-coordination.js'
import { recoverReviewRunSubmission } from '../control-plane/submission-recovery.js'

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
  const result = await coordinateTerminalRun(store, run, {
    getStatus: async runId => await get_runner_run_status({ run_id: runId }),
    describeError: error => ({ code: asErrorCode(error), message: asErrorMessage(error) }),
    isTerminalPollingError: isTerminalRunnerPollingError,
    runnerFailureFromStatus: status => {
      try {
        completedRunnerRunResult(status as RunnerRunStatus)
        return new Error(`Runner run failed without an error: ${run.run_id}`)
      } catch (error) {
        return error
      }
    },
    publish: async (status, claimToken) => await handleWorkflowRun({
      app,
      run,
      status: status as RunnerRunStatus,
      store,
      claim_token: claimToken
    }),
    classifyPublicationFailure: error => {
      const classification = classifyPublicationFailure(error)
      return {
        ...classification,
        code: asErrorCode(error) ?? classification.code,
        message: asErrorMessage(error)
      }
    },
    onHeartbeatError: error => {
      // A transient database outage does not prove ownership was lost. The last
      // successful heartbeat still prevents takeover until its lease expires.
      logWarn('runner_run_publish_heartbeat_failed', {
        error,
        error_message: asErrorMessage(error),
        connector_id: store.connector_id,
        run_id: run.run_id,
        workflow: run.workflow
      })
    }
  })

  if (result.status === 'active') return
  if (result.status === 'poll_retry') {
    logWarn('runner_run_status_poll_failed', {
      error: result.error,
      error_message: asErrorMessage(result.error),
      connector_id: store.connector_id,
      run_id: run.run_id,
      workflow: run.workflow
    })
    return
  }
  if (result.status === 'runner_failed') {
    const pollingFailure = result.source === 'poll'
    logError(pollingFailure ? 'runner_run_status_poll_terminal_failure' : 'runner_run_failed', {
      error: result.error,
      error_message: result.failure.message,
      connector_id: store.connector_id,
      ...(!pollingFailure ? { failure_code: result.failure.code ?? 'RUNNER_EXECUTION_FAILED' } : {}),
      run_id: run.run_id,
      workflow: run.workflow
    })
    return
  }
  if (result.status === 'publication_claim_unavailable') {
    logInfo('runner_run_publish_claim_skipped', {
      connector_id: store.connector_id,
      run_id: run.run_id,
      workflow: run.workflow
    })
    return
  }
  if (result.status === 'publication_claim_lost') {
    logWarn('runner_run_publish_claim_lost', {
      attempted_state: result.attempted_state,
      connector_id: store.connector_id,
      run_id: run.run_id,
      workflow: run.workflow
    })
    return
  }
  if (result.status === 'published') {
    logInfo('runner_run_publish_completed', {
      connector_id: store.connector_id,
      run_id: run.run_id,
      workflow: run.workflow
    })
    return
  }
  logError('runner_run_publish_failed', {
    diagnostic_state: result.failure.reason,
    error: result.error,
    error_message: result.failure.message,
    failure_code: result.failure.code,
    retry: result.failure.retry,
    connector_id: store.connector_id,
    run_id: run.run_id,
    status_after: result.status_after,
    status_before: run.status,
    workflow: run.workflow
  })
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
  const result = await recoverReviewRunSubmission(store, run, {
    // Runner treats the same run ID and request as the same submission. Replaying
    // the persisted POST therefore recovers both accepted and missing runs.
    submit: submit_runner_run,
    classifyError: error => ({
      uncertain: error instanceof RunnerSubmissionUncertainError,
      code: error instanceof RunnerSubmissionUncertainError
        ? 'SUBMISSION_STATE_UNCERTAIN'
        : asErrorCode(error) ?? 'REVIEW_START_FAILED',
      message: asErrorMessage(error)
    })
  })
  if (result.status === 'recovered') {
    logInfo('runner_submission_recovered', {
      connector_id: store.connector_id,
      resolution: 'idempotent-submission-replayed',
      run_id: run.run_id,
      workflow: run.workflow
    })
  } else if (result.status === 'deferred') {
    logWarn('runner_submission_recovery_deferred', {
      error: result.error,
      error_message: asErrorMessage(result.error),
      connector_id: store.connector_id,
      run_id: run.run_id,
      workflow: run.workflow
    })
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
  await coordinateReviewRunsOnce(store, {
    recoverSubmission: async run => await recoverSubmission({ store, run, submit_runner_run }),
    observeActiveRun: async run => await publishCompletedRun({ app, store, run, get_runner_run_status })
  })
}

export function startRunnerRunPublisher ({
  app,
  store = reviewRunStore,
  intervalMs = pollIntervalMs(),
  get_runner_run_status = getRunnerRunStatus,
  submit_runner_run = submitRunnerRun
}: ReviewRunPublisherOptions): ReviewRunPublisher {
  const loop = startReviewRunCoordinatorLoop({
    intervalMs,
    runOnce: async () => await publishReviewRunsOnce({ app, store, get_runner_run_status, submit_runner_run }),
    onError: error => {
      logError('runner_run_publisher_failed', {
        error,
        error_message: asErrorMessage(error),
        connector_id: store.connector_id
      })
    }
  })
  logInfo('runner_run_publisher_started', {
    connector_id: store.connector_id,
    interval_ms: intervalMs
  })
  return loop
}
