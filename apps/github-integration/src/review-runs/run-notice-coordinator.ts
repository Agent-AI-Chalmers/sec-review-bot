import { clearInterval } from 'node:timers'
import type { App } from 'octokit'

import { installationOctokitForRepo } from '../github/installation-client.js'
import { repositoryFullName } from '../github/repository-service.js'
import { isRecord } from '../utils/error-utils.js'
import { integerEnv } from '../utils/env.js'
import { logError, logInfo } from '../utils/logger.js'
import { reviewRunsClient, type RunNoticeCoordinatorStore } from './client.js'
import { classifyPreparationFailure } from './preparation-failure.js'
import { sendRunNoticeReply } from './run-notice-reply.js'

export interface RunNoticeCoordinator {
  stop: () => Promise<void>
}

class InvalidRunNoticeInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRunNoticeInputError'
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value))
    throw new InvalidRunNoticeInputError(
      `Run notice input is missing ${label}.`
    )
  return value
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new InvalidRunNoticeInputError(
      `Run notice input is missing ${label}.`
    )
  return value
}

/** Resolve the repository whose GitHub App installation must deliver a notice. */
function noticeRepository(input: Record<string, unknown>): string | null {
  if (isRecord(input.issue))
    return requireText(input.issue.repo_full_name, 'issue.repo_full_name')
  if (isRecord(input.pr))
    return requireText(input.pr.repo_full_name, 'pr.repo_full_name')
  if (isRecord(input.pr_reference)) {
    const owner = requireText(
      input.pr_reference.owner_login,
      'pr_reference.owner_login'
    )
    const name = requireText(
      input.pr_reference.repo_name,
      'pr_reference.repo_name'
    )
    return `${owner}/${name}`
  }
  return repositoryFullName(input.verified_repository)
}

/** Deliver one run-level notice, regardless of which lifecycle axis produced it. */
export async function deliverRunNoticeOnce({
  app,
  store = reviewRunsClient
}: {
  app: App
  store?: RunNoticeCoordinatorStore
}): Promise<boolean> {
  const notice = await store.claimNextRunNotice()
  if (notice === null) return false
  try {
    const input = requireRecord(notice.input, 'object')
    const repo = noticeRepository(input)
    const delivered =
      repo === null
        ? null
        : await sendRunNoticeReply(
            await installationOctokitForRepo(app, repo),
            {
              run_id: notice.run_id,
              notice_id: notice.notice_id,
              input,
              axis: notice.axis,
              kind: notice.kind,
              reason_code: notice.reason_code
            }
          )
    if (delivered === null) {
      await store.completeRunNotice(notice.notice_id, notice.claim_token, false)
    } else {
      await store.completeRunNotice(
        notice.notice_id,
        notice.claim_token,
        true,
        delivered.comment_url
      )
    }
  } catch (error) {
    // Retry transient GitHub faults after the claim lease expires. Deterministic input or
    // installation failures are concluded so one undeliverable notice cannot loop forever.
    if (
      !classifyPreparationFailure(
        error,
        1,
        error instanceof InvalidRunNoticeInputError
      ).retry
    )
      await store.completeRunNotice(notice.notice_id, notice.claim_token, false)
    logError('review_run_notice_delivery_failed', {
      error,
      run_id: notice.run_id
    })
  }
  return true
}

export function startRunNoticeCoordinator({
  app,
  store = reviewRunsClient,
  intervalMs = integerEnv('REVIEW_RUNS_NOTICE_POLL_INTERVAL_MS', 5000)
}: {
  app: App
  store?: RunNoticeCoordinatorStore
  intervalMs?: number
}): RunNoticeCoordinator {
  let active: Promise<void> | null = null
  const run = (): void => {
    if (active !== null) return
    active = (async () => {
      while (await deliverRunNoticeOnce({ app, store })) {
        // Drain currently available notices before returning to the poll interval.
      }
    })()
      .catch((error) =>
        logError('review_run_notice_coordinator_failed', { error })
      )
      .finally(() => {
        active = null
      })
  }
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref?.()
  logInfo('review_run_notice_coordinator_started', { interval_ms: intervalMs })
  return {
    stop: async () => {
      clearInterval(timer)
      await active
    }
  }
}
