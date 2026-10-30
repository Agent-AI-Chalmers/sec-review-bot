// Reclaims durable preparation work after an integration process exits mid-prepare.
// It interprets connector-owned input, while Review Runs owns claims and retries.
import { clearInterval } from 'node:timers'
import type { App } from 'octokit'

import { reviewRunsClient, type PreparationCoordinatorStore } from './client.js'
import { startIssueReviewCommand } from '../triggers/issue-review.js'
import { startPullRequestReviewCommand } from '../triggers/pull-request-review.js'
import { dispatchRepositoryReview } from '../triggers/repository-review.js'
import type { IssueContext } from '../github/issue-service.js'
import {
  getPullRequestContext,
  type PullRequestContext
} from '../github/pull-request-service.js'
import type { TrustedDefaultBranch } from '../github/default-branch-service.js'
import { isRecord } from '../utils/error-utils.js'
import { integerEnv } from '../utils/env.js'
import { logError, logInfo } from '../utils/logger.js'
import {
  classifyPreparationFailure,
  InvalidPreparationInputError
} from './preparation-failure.js'
import { installationOctokitForRepo } from '../github/installation-client.js'

interface PreparationCoordinator {
  stop: () => Promise<void>
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

/** Field checks for values read back from persisted preparation input.
 *
 * These records were written by an earlier run of this service and are replayed on recovery, so
 * they arrive as untyped JSON. Casting one straight to its domain type (`as unknown as ...`) would
 * compile while promising fields the value may not have: a field added to the type, or a record
 * written by an older release, would produce `undefined` at a call that expects a string. The
 * checks below name the fields the recovery path actually reads, so a bad record is rejected as
 * invalid preparation input instead of being handed on.
 *
 * Every field the recovered context declares is required: there is no forward compatibility for
 * older records that omit one. A record missing a field is rejected rather than filled in with a
 * default, so a schema change surfaces as an explicit preparation failure instead of a silently
 * degraded review. */

function requireStringField(
  record: Record<string, unknown>,
  field: string,
  label: string
): string {
  return requireText(record[field], `${label}.${field}`)
}

function requireNumberField(
  record: Record<string, unknown>,
  field: string,
  label: string
): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new InvalidPreparationInputError(
      `Preparation input is missing ${label}.${field}`
    )
  return value
}

function requireBooleanField(
  record: Record<string, unknown>,
  field: string,
  label: string
): boolean {
  const value = record[field]
  if (typeof value !== 'boolean')
    throw new InvalidPreparationInputError(
      `Preparation input is missing ${label}.${field}`
    )
  return value
}

/** The issue fields the recovered issue-review path reads. */
function requireIssueContext(value: unknown, label = 'issue'): IssueContext {
  const record = requireRecord(value, label)
  // `sender_login` and `issue_author` are `string` in the extracted context (the extractor
  // normalises an absent login to `''`), so the persisted record must carry a string. Omitting
  // them is not treated as "unknown": the record is rejected.
  const sender_login = requireStringField(record, 'sender_login', label)
  const issue_author = requireStringField(record, 'issue_author', label)
  const issue_body = record.issue_body
  if (issue_body !== null && typeof issue_body !== 'string')
    throw new InvalidPreparationInputError(
      `Preparation input has an invalid ${label}.issue_body`
    )
  const labels = record.labels
  if (!Array.isArray(labels) || labels.some((item) => typeof item !== 'string'))
    throw new InvalidPreparationInputError(
      `Preparation input is missing ${label}.labels`
    )
  return {
    action: requireStringField(record, 'action', label),
    repo_name: requireStringField(record, 'repo_name', label),
    repo_full_name: requireStringField(record, 'repo_full_name', label),
    owner_login: requireStringField(record, 'owner_login', label),
    sender_login,
    default_branch: requireStringField(record, 'default_branch', label),
    issue_number: requireNumberField(record, 'issue_number', label),
    issue_title: requireStringField(record, 'issue_title', label),
    issue_body,
    issue_author,
    issue_state: requireStringField(record, 'issue_state', label),
    labels: labels as string[],
    html_url: requireStringField(record, 'html_url', label),
    api_url: requireStringField(record, 'api_url', label),
    comments_url: requireStringField(record, 'comments_url', label),
    is_pull_request: requireBooleanField(record, 'is_pull_request', label)
  }
}

/**
 * The pull request fields a recovered run reads.
 *
 * This is the parsed webhook payload shape that admission persists, not the
 * review subject: the subject is a preparation output (it carries the resolved
 * window and the commit list), while this input exists before preparation
 * starts. They are separate lifecycles and must not share a validator.
 */
function requirePersistedPullRequest(
  value: unknown,
  label = 'pr'
): PullRequestContext {
  const record = requireRecord(value, label)
  return {
    action: requireStringField(record, 'action', label),
    previous_head_sha: optionalStringOrNull(record, 'previous_head_sha', label),
    repo_name: requireStringField(record, 'repo_name', label),
    repo_full_name: requireStringField(record, 'repo_full_name', label),
    owner_login: requireStringField(record, 'owner_login', label),
    sender_login: optionalStringOrNull(record, 'sender_login', label),
    pr_number: requireNumberField(record, 'pr_number', label),
    pr_title: requireStringField(record, 'pr_title', label),
    pr_body: optionalStringOrNull(record, 'pr_body', label),
    pr_author: optionalStringOrNull(record, 'pr_author', label),
    is_draft: requireBooleanField(record, 'is_draft', label),
    base_ref: requireStringField(record, 'base_ref', label),
    base_sha: requireStringField(record, 'base_sha', label),
    head_ref: requireStringField(record, 'head_ref', label),
    head_sha: requireStringField(record, 'head_sha', label),
    commits: requireNumberField(record, 'commits', label),
    changed_files: requireNumberField(record, 'changed_files', label),
    additions: requireNumberField(record, 'additions', label),
    deletions: requireNumberField(record, 'deletions', label),
    html_url: requireStringField(record, 'html_url', label),
    api_url: requireStringField(record, 'api_url', label),
    commits_url: requireStringField(record, 'commits_url', label),
    review_comments_url: requireStringField(
      record,
      'review_comments_url',
      label
    ),
    comments_url: requireStringField(record, 'comments_url', label),
    issue_url: requireStringField(record, 'issue_url', label),
    head_repo_full_name: optionalStringOrNull(
      record,
      'head_repo_full_name',
      label
    ),
    base_repo_full_name: optionalStringOrNull(
      record,
      'base_repo_full_name',
      label
    ),
    from_fork: requireBooleanField(record, 'from_fork', label)
  }
}
function optionalStringOrNull(
  record: Record<string, unknown>,
  field: string,
  label: string
): string | null {
  const value = record[field]
  if (value !== null && typeof value !== 'string')
    throw new InvalidPreparationInputError(
      `Preparation input has an invalid ${label}.${field}`
    )
  return value
}

/** The two fields a trusted default branch is made of. */
function requireTrustedDefaultBranch(
  value: unknown,
  label = 'trusted_default_branch'
): TrustedDefaultBranch {
  const record = requireRecord(value, label)
  return {
    default_branch: requireStringField(record, 'default_branch', label),
    head_sha: requireStringField(record, 'head_sha', label)
  }
}

async function executeClaimedPreparation({
  app,
  store,
  work
}: {
  app: App
  store: PreparationCoordinatorStore
  work: NonNullable<
    Awaited<ReturnType<PreparationCoordinatorStore['claimNextPreparation']>>
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
    const issue = requireIssueContext(input.issue)
    const octokit = await installationOctokitForRepo(app, issue.repo_full_name)
    await startIssueReviewCommand({
      octokit,
      issue,
      trusted_default_branch: requireTrustedDefaultBranch(
        input.trusted_default_branch
      ),
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
    // A persisted payload is the snapshot this run was admitted for. It is used
    // as-is rather than re-read: a fresh read has no webhook `before` commit, so a
    // `synchronize` would lose its push window and silently widen to the whole
    // pull request, and a push landing during downtime would move the head under
    // the same run id. Only the reference form, which never captured a snapshot,
    // resolves the pull request now.
    const persistedPr = isRecord(input.pr)
      ? requirePersistedPullRequest(input.pr)
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
      trusted_default_branch: requireTrustedDefaultBranch(
        input.trusted_default_branch
      ),
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
      payload: requireRecord(input.payload, 'payload'),
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

export async function prepareReviewRunsOnce({
  app,
  store = reviewRunsClient
}: {
  app: App
  store?: PreparationCoordinatorStore
}): Promise<boolean> {
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
  return false
}

export function startPreparationCoordinator({
  app,
  store = reviewRunsClient,
  intervalMs = integerEnv('REVIEW_RUNS_PREPARATION_POLL_INTERVAL_MS', 5000)
}: {
  app: App
  store?: PreparationCoordinatorStore
  intervalMs?: number
}): PreparationCoordinator {
  let active: Promise<void> | null = null
  const run = (): void => {
    if (active !== null) return
    active = (async () => {
      while (await prepareReviewRunsOnce({ app, store })) {
        // Drain currently available preparations before returning to the poll interval.
      }
    })()
      .catch((error) => {
        // A failed Review Runs poll has no work claim to repair. Log it and
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
