import type { App } from 'octokit'

import {
  getRunnerRunStatus,
  type RunnerRunStatus
} from './client.js'
import {
  runnerRunStore,
  type RunnerRunRecord,
  type RunnerRunStore
} from './run-store.js'
import { splitRepoFullName } from '../github/repository-service.js'
import { handleIssueReviewRun } from '../../reviews/issues/publish.js'
import { handlePullRequestReviewRun } from '../../reviews/pull-requests/publish.js'
import { handleRepositoryReviewRun } from '../../reviews/repositories/publish.js'
import { logError, logInfo } from '../../utils/logger.js'
import { asErrorWithResponse } from '../../utils/error-utils.js'
import { RUNNER_PUBLISH_ERROR_CODES } from './publish-error-code.js'
import { isDeterministicRunnerPublishError } from './publish-error.js'

type JsonObject = Record<string, unknown>

interface RunnerRunPublisherOptions {
  app: App
  store?: RunnerRunStore
  intervalMs?: number
}

type GetRunnerRunStatus = typeof getRunnerRunStatus

type InstallationOctokitForRepo = (repo_full_name: string) => Promise<unknown>

type RunPublishHandler = (args: {
  run: RunnerRunRecord
  status: RunnerRunStatus
  installation_octokit_for_repo: InstallationOctokitForRepo
}) => Promise<void>

interface PublishFailureClassification {
  retry: boolean
  code: string | null
  reason: string
}

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

export function shouldRetryRunnerPublishFailure (error: unknown): boolean {
  return classifyRunnerPublishFailure(error).retry
}

function isRateLimitOrAbuseLimit (error: unknown): boolean {
  const errorInfo = asErrorWithResponse(error)
  const headers = errorInfo.response?.headers ?? {}
  const retryAfter = headers['retry-after'] ?? headers['Retry-After']
  const rateRemaining = headers['x-ratelimit-remaining'] ?? headers['X-RateLimit-Remaining']
  const message = [
    errorInfo.message,
    errorInfo.response?.data?.message
  ].join(' ').toLowerCase()

  return retryAfter !== undefined ||
    rateRemaining === '0' ||
    message.includes('rate limit') ||
    message.includes('secondary rate limit') ||
    message.includes('abuse')
}

export function classifyRunnerPublishFailure (error: unknown): PublishFailureClassification {
  // Runner service failures and malformed stored results are deterministic for
  // this run; transient GitHub/API publish failures still use publish_failed.
  if (isRecord(error) && error.name === 'AgentRunnerServiceError') {
    return {
      retry: false,
      code: asErrorCode(error),
      reason: 'runner-service-terminal'
    }
  }
  if (isDeterministicRunnerPublishError(error)) {
    return {
      retry: false,
      code: asErrorCode(error),
      reason: 'deterministic-publish-result'
    }
  }

  const responseStatus = asErrorWithResponse(error).response?.status
  if (responseStatus === undefined) {
    return {
      retry: true,
      code: asErrorCode(error),
      reason: 'unknown-publish-error'
    }
  }
  if (responseStatus >= 500 || responseStatus === 408 || responseStatus === 409 || responseStatus === 429) {
    return {
      retry: true,
      code: asErrorCode(error),
      reason: 'github-transient-response'
    }
  }
  if (responseStatus === 403 && isRateLimitOrAbuseLimit(error)) {
    return {
      retry: true,
      code: asErrorCode(error),
      reason: 'github-rate-limited'
    }
  }
  if (responseStatus === 401 || responseStatus === 403) {
    return {
      retry: false,
      code: asErrorCode(error) ?? RUNNER_PUBLISH_ERROR_CODES.github_auth_rejected,
      reason: 'github-auth-rejected'
    }
  }
  if (responseStatus === 404) {
    return {
      retry: false,
      code: asErrorCode(error) ?? RUNNER_PUBLISH_ERROR_CODES.github_not_found,
      reason: 'github-not-found'
    }
  }
  if (responseStatus === 422) {
    return {
      retry: false,
      code: asErrorCode(error) ?? RUNNER_PUBLISH_ERROR_CODES.github_validation_rejected,
      reason: 'github-validation-rejected'
    }
  }
  if (responseStatus >= 400 && responseStatus < 500) {
    return {
      retry: false,
      code: asErrorCode(error) ?? RUNNER_PUBLISH_ERROR_CODES.github_publish_rejected,
      reason: 'github-deterministic-response'
    }
  }

  return {
    retry: true,
    code: asErrorCode(error),
    reason: 'github-unclassified-response'
  }
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
  status
}: {
  app: App
  run: RunnerRunRecord
  status: RunnerRunStatus
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
  store: RunnerRunStore
  run: RunnerRunRecord
  get_runner_run_status?: GetRunnerRunStatus
}): Promise<void> {
  const status = await get_runner_run_status({ run_id: run.run_id })
  if (status.status !== 'succeeded' && status.status !== 'failed') {
    if (status.status === 'running' && run.status === 'queued') {
      store.markRunning(run.run_id)
    }
    return
  }

  if (!store.markPublishing(run.run_id)) {
    logInfo('runner_run_publish_claim_skipped', {
      run_id: run.run_id,
      workflow: run.workflow
    })
    return
  }
  await handleWorkflowRun({ app, run, status })
  store.markPublished(run.run_id)
  logInfo('runner_run_publish_completed', {
    run_id: run.run_id,
    workflow: run.workflow
  })
}

export async function publishRunnerRunsOnce ({
  app,
  store = runnerRunStore,
  get_runner_run_status = getRunnerRunStatus
}: {
  app: App
  store?: RunnerRunStore
  get_runner_run_status?: GetRunnerRunStatus
}): Promise<void> {
  for (const run of store.listActiveRuns()) {
    try {
      await publishCompletedRun({ app, store, run, get_runner_run_status })
    } catch (error) {
      const message = asErrorMessage(error)
      const classification = classifyRunnerPublishFailure(error)
      const code = asErrorCode(error) ?? classification.code
      if (classification.retry) {
        store.markPublishFailed(run.run_id, { code, message })
      } else {
        store.markFailed(run.run_id, { code, message })
      }
      const updatedRun = store.getRun(run.run_id)
      logError('runner_run_publish_failed', {
        diagnostic_state: classification.reason,
        error,
        error_message: message,
        failure_code: code,
        publish_attempts: updatedRun?.publish_attempts ?? run.publish_attempts,
        retry: classification.retry,
        run_id: run.run_id,
        status_after: updatedRun?.status ?? null,
        status_before: run.status,
        workflow: run.workflow
      })
    }
  }
}

export function startRunnerRunPublisher ({ app, store = runnerRunStore, intervalMs = pollIntervalMs() }: RunnerRunPublisherOptions): ReturnType<typeof setInterval> {
  let active = false
  const tick = (): void => {
    if (active) {
      return
    }
    active = true
    void publishRunnerRunsOnce({ app, store })
      .catch((error: unknown) => {
        logError('runner_run_publisher_failed', {
          error,
          error_message: asErrorMessage(error)
        })
      })
      .finally(() => {
        active = false
      })
  }

  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  setImmediate(tick)
  logInfo('runner_run_publisher_started', {
    interval_ms: intervalMs
  })
  return timer
}
