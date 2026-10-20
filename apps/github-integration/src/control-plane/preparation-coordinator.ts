// Reclaims durable preparation work after an integration process exits mid-prepare.
// It interprets connector-owned input, while Control Plane owns claims and retries.
import { clearInterval } from 'node:timers'
import type { App } from 'octokit'

import { controlPlaneClient, type ControlPlaneClient } from './client.js'
import { startIssueReviewCommand } from '../triggers/issue-review.js'
import { startPullRequestReviewCommand } from '../triggers/pull-request-review.js'
import {
  dispatchRepositoryReview,
  type RepositoryReviewDispatchPayload
} from '../triggers/repository-review.js'
import type { IssueContext } from '../github/issue-service.js'
import {
  getPullRequestContext,
  type PullRequestContext
} from '../github/pull-request-service.js'
import type { TrustedDefaultBranch } from '../github/default-branch-service.js'
import { repositoryFullName } from '../github/repository-service.js'
import { isRecord } from '../utils/error-utils.js'
import { logError, logInfo } from '../utils/logger.js'
import {
  classifyPreparationFailure,
  InvalidPreparationInputError
} from './preparation-failure.js'
import { sendRunFailureReply } from './run-failure-reply.js'
import { installationOctokitForRepo } from '../github/installation-client.js'

interface PreparationCoordinator {
  stop: () => Promise<void>
}

function pollIntervalMs(): number {
  const parsed = Number.parseInt(
    process.env.CONTROL_PLANE_PREPARATION_POLL_INTERVAL_MS || '5000',
    10
  )
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value))
    throw new InvalidPreparationInputError(
      `Preparation input is missing ${label}.`
    )
  return value
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new InvalidPreparationInputError(
      `Preparation input is missing ${label}.`
    )
  return value
}

async function executeClaimedPreparation({
  app,
  store,
  work
}: {
  app: App
  store: ControlPlaneClient
  work: NonNullable<
    Awaited<ReturnType<ControlPlaneClient['claimNextPreparation']>>
  >
}): Promise<void> {
  if (work.input_version !== 'v1')
    throw new InvalidPreparationInputError(
      `Unsupported preparation input version ${work.input_version}.`
    )
  const input = requireRecord(work.input, 'object')
  const kind = requireText(input.kind, 'kind')
  const claimed_preparation = {
    run_id: work.run_id,
    token: work.claim_token,
    attempt_count: work.attempt_count
  }

  if (kind === 'github_issue_review' && work.workflow === 'issue-review') {
    const issue = requireRecord(input.issue, 'issue') as unknown as IssueContext
    const octokit = await installationOctokitForRepo(app, issue.repo_full_name)
    await startIssueReviewCommand({
      octokit,
      issue,
      trusted_default_branch: requireRecord(
        input.trusted_default_branch,
        'trusted_default_branch'
      ) as unknown as TrustedDefaultBranch,
      event_type: input.event_type as 'opened' | 'manual_review',
      review_objective: input.review_objective as 'audit' | 'repair' | null,
      test_changes: input.test_changes as null,
      open_pr: input.open_pr as boolean | null,
      delivery_id: `recovered:${work.run_id}`,
      claimed_preparation,
      deps: { store }
    })
    return
  }

  if (
    kind === 'github_pull_request_review' &&
    work.workflow === 'pull-request-review'
  ) {
    const persistedPr = isRecord(input.pr)
      ? (input.pr as unknown as PullRequestContext)
      : null
    const reference =
      persistedPr === null
        ? requireRecord(input.pr_reference, 'pr_reference')
        : null
    const owner_login =
      persistedPr?.owner_login ??
      requireText(reference?.owner_login, 'pr_reference.owner_login')
    const repo_name =
      persistedPr?.repo_name ??
      requireText(reference?.repo_name, 'pr_reference.repo_name')
    const octokit = await installationOctokitForRepo(
      app,
      persistedPr?.repo_full_name ?? `${owner_login}/${repo_name}`
    )
    const pr =
      persistedPr ??
      (await getPullRequestContext(octokit, {
        owner_login,
        repo_name,
        pr_number: Number(reference?.pr_number)
      }))
    await startPullRequestReviewCommand({
      octokit,
      pr,
      trusted_default_branch: requireRecord(
        input.trusted_default_branch,
        'trusted_default_branch'
      ) as unknown as TrustedDefaultBranch,
      event_type: input.event_type as
        'opened' | 'ready_for_review' | 'synchronize' | 'manual_review',
      test_changes: input.test_changes as null,
      delivery_id: `recovered:${work.run_id}`,
      preparation_input: input,
      claimed_preparation,
      deps: { store }
    })
    return
  }

  if (
    kind === 'github_repository_review' &&
    work.workflow === 'repository-review'
  ) {
    await dispatchRepositoryReview({
      app,
      payload: requireRecord(
        input.payload,
        'payload'
      ) as RepositoryReviewDispatchPayload,
      verified_repository: requireText(
        input.verified_repository,
        'verified_repository'
      ),
      claimed_preparation,
      deps: { store }
    })
    return
  }

  throw new InvalidPreparationInputError(
    `Preparation input kind ${kind} does not match ${work.workflow}.`
  )
}

/** The repository a notice belongs to, in `owner/repo` form, or null when it names none.
 *
 * Each workflow carries its repository differently: issue and pull-request inputs nest it, a
 * pull-request reference splits it across two fields, and a repository scan names it directly.
 * The value picks the installation token, but it must agree with the reply path's own check:
 * when it accepted `owner/repo/extra` while the reply path rejected it, the installation lookup
 * threw on every attempt and the notice was re-claimed forever without ever being concluded.
 * Both sides therefore treat anything that is not exactly two non-empty segments as no target. */
function noticeRepository(input: Record<string, unknown>): string | null {
  if (isRecord(input.issue)) {
    return requireText(input.issue.repo_full_name, 'issue.repo_full_name')
  }
  if (isRecord(input.pr)) {
    return requireText(input.pr.repo_full_name, 'pr.repo_full_name')
  }
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

async function deliverNextRunFailureNotice({
  app,
  store
}: {
  app: App
  store: ControlPlaneClient
}): Promise<boolean> {
  const notice = await store.claimNextRunFailureNotice()
  if (notice === null) return false
  try {
    const input = requireRecord(notice.input, 'object')
    // The repository only selects the installation whose token posts the notice; the reply path
    // decides which conversation or summary issue the outcome belongs to. A repository scan has
    // no conversation, so it names its repository directly.
    const repo = noticeRepository(input)
    const delivered =
      repo === null
        ? null
        : await sendRunFailureReply(
            await installationOctokitForRepo(app, repo),
            {
              run_id: notice.run_id,
              input,
              failure_stage: notice.failure_stage,
              // A notice always names the stage; only the reason can be missing. The fallback
              // keeps the reply readable without inventing a preparation failure for a run that
              // actually failed later.
              failure_code:
                notice.failure_code ??
                `${notice.failure_stage.toUpperCase()}_FAILED`
            }
          )
    // A posted reply names its comment; a failed delivery has none to name.
    if (delivered === null) {
      await store.completeRunFailureNotice(
        notice.run_id,
        notice.claim_token,
        false
      )
    } else {
      await store.completeRunFailureNotice(
        notice.run_id,
        notice.claim_token,
        true,
        delivered.comment_url
      )
    }
  } catch (error) {
    // A transient GitHub or network fault is worth retrying: the lease makes the notice
    // eligible for another process once it expires, and an eventual delivery is preferable to
    // silently losing a terminal outcome. A fault that cannot be repaired by retrying - a
    // repository name that is not `owner/repo`, or a persisted input of the wrong shape - would
    // otherwise be re-claimed every lease period forever, so it is concluded as an undelivered
    // notice instead. The distinction is what `classifyPreparationFailure` already encodes.
    if (!classifyPreparationFailure(error, 1).retry) {
      await store.completeRunFailureNotice(
        notice.run_id,
        notice.claim_token,
        false
      )
    }
    logError('review_preparation_terminal_reply_failed', {
      error,
      run_id: notice.run_id
    })
  }
  return true
}

export async function prepareReviewRunsOnce({
  app,
  store = controlPlaneClient,
  preferFailureNotice = true
}: {
  app: App
  store?: ControlPlaneClient
  preferFailureNotice?: boolean
}): Promise<boolean> {
  if (
    preferFailureNotice &&
    (await deliverNextRunFailureNotice({ app, store }))
  )
    return true
  const work = await store.claimNextPreparation()
  if (work !== null) {
    try {
      await executeClaimedPreparation({ app, store, work })
    } catch (error) {
      // The workflow may already have consumed its token into a terminal or
      // submission-recovery state. Only fail the preparation if it still owns it.
      try {
        const classification = classifyPreparationFailure(
          error,
          work.attempt_count
        )
        await store.failPreparation(
          work.run_id,
          work.claim_token,
          {
            code: 'PREPARATION_RECOVERY_FAILED',
            message: error instanceof Error ? error.message : String(error)
          },
          {
            retry: classification.retry,
            ...(classification.retryAfterMs === undefined
              ? {}
              : { retryAfterMs: classification.retryAfterMs })
          }
        )
      } catch {
        // A fenced owner cannot overwrite the state chosen by the current owner.
      }
      logError('review_preparation_recovery_failed', {
        error,
        run_id: work.run_id,
        workflow: work.workflow
      })
    }
    return true
  }
  // When this pass gave preparations first chance but found none, keep terminal
  // feedback responsive. A failed notice remains claimed until its lease expires,
  // so this fallback never becomes a hot retry loop.
  return preferFailureNotice
    ? false
    : await deliverNextRunFailureNotice({ app, store })
}

export function startPreparationCoordinator({
  app,
  store = controlPlaneClient,
  intervalMs = pollIntervalMs()
}: {
  app: App
  store?: ControlPlaneClient
  intervalMs?: number
}): PreparationCoordinator {
  let active: Promise<void> | null = null
  const run = (): void => {
    if (active !== null) return
    active = (async () => {
      let preferFailureNotice = true
      while (await prepareReviewRunsOnce({ app, store, preferFailureNotice })) {
        // Alternate only while both queues have work. This keeps terminal replies
        // prompt without allowing a sustained notice backlog to starve preparation.
        preferFailureNotice = !preferFailureNotice
      }
    })()
      .catch((error) => {
        // A failed Control Plane poll has no work claim to repair. Log it and
        // let the next interval retry instead of leaking an unhandled rejection.
        logError('review_preparation_coordinator_failed', { error })
      })
      .finally(() => {
        active = null
      })
  }
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref?.()
  logInfo('review_preparation_coordinator_started', { interval_ms: intervalMs })
  return {
    stop: async () => {
      clearInterval(timer)
      await active
    }
  }
}
