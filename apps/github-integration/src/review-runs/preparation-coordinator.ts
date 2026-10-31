// Reclaims durable preparation work after an integration process exits mid-prepare.
// It interprets connector-owned input, while Review Runs owns claims and retries.
import { clearInterval } from 'node:timers'
import type { App } from 'octokit'

import { reviewRunsClient, type PreparationCoordinatorStore } from './client.js'
import { startIssueReviewCommand } from '../triggers/issue-review.js'
import { startPullRequestReviewCommand } from '../triggers/pull-request-review.js'
import { dispatchRepositoryReview } from '../triggers/repository-review.js'
import { getPullRequestContext } from '../github/pull-request-service.js'
import { isRecord } from '../utils/error-utils.js'
import { integerEnv } from '../utils/env.js'
import { logError, logInfo } from '../utils/logger.js'
import {
  classifyPreparationFailure,
  InvalidPreparationInputError
} from './preparation-failure.js'
import {
  parseRepositoryPreparationInput,
  parseIssuePreparationInput,
  parsePullRequestPreparationInput
} from './preparation-input.js'
import { installationOctokitForRepo } from '../github/installation-client.js'

interface PreparationCoordinator {
  stop: () => Promise<void>
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
  if (!isRecord(work.input))
    throw new InvalidPreparationInputError(
      'Preparation input is missing object.'
    )
  const input = work.input
  const kind = input.kind
  const claimed_preparation = {
    run_id: work.run_id,
    token: work.claim_token,
    attempt_count: work.attempt_count
  }

  if (kind === 'github_issue_review' && work.workflow === 'issue-review') {
    const recovered = parseIssuePreparationInput(input)
    const { issue } = recovered
    const octokit = await installationOctokitForRepo(app, issue.repo_full_name)
    await startIssueReviewCommand({
      octokit,
      issue,
      trusted_default_branch: recovered.trusted_default_branch,
      event_type: recovered.event_type,
      review_objective: recovered.review_objective,
      test_changes: recovered.test_changes,
      open_pr: recovered.open_pr,
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
    const recovered = parsePullRequestPreparationInput(input)
    const persistedPr = recovered.pr
    const identity = persistedPr ?? recovered.pr_reference
    const { owner_login, repo_name } = identity
    const octokit = await installationOctokitForRepo(
      app,
      persistedPr?.repo_full_name ?? `${owner_login}/${repo_name}`
    )
    const pr =
      persistedPr ??
      (await getPullRequestContext(octokit, {
        owner_login,
        repo_name,
        pr_number: identity.pr_number
      }))
    await startPullRequestReviewCommand({
      octokit,
      pr,
      trusted_default_branch: recovered.trusted_default_branch,
      event_type: recovered.event_type,
      test_changes: recovered.test_changes,
      delivery_id: `recovered:${work.run_id}`,
      preparation_input: { ...recovered, pr },
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
      ...parseRepositoryPreparationInput(input),
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
