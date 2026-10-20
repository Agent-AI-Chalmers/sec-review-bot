// Handles authorized GitHub issue-comment commands and starts the appropriate
// durable review workflow without making webhook delivery own long-running work.
import type { EmitterWebhookEvent } from '@octokit/webhooks'

import { startIssueReviewCommand } from '../../../triggers/issue-review.js'
import { startPullRequestReviewCommand } from '../../../triggers/pull-request-review.js'
import {
  extractCommentCommand,
  recognizedMentions,
  unmatchedMentions
} from '../../../github/comment-command-service.js'
import { authorizeManualCommentCommand } from '../../../github/manual-command-authorization.js'
import { extractIssueContext } from '../../../github/issue-service.js'
import { getPullRequestContext } from '../../../github/pull-request-service.js'
import { resolveTrustedDefaultBranch } from '../../../github/default-branch-service.js'
import type { Octokit } from 'octokit'
import {
  isSelfOriginatedWebhookEvent,
  logSkippedSelfOriginatedEvent
} from '../../../github/webhook-origin-guard.js'
import { logError, logInfo } from '../../../utils/logger.js'
import { asErrorWithResponse } from '../../../utils/error-utils.js'
import { createLogThrottle } from '../../../utils/log-throttle.js'
import { backgroundPreparations } from '../../../reviews/background-preparations.js'
import {
  type TrustedRefHandlerDeps,
  type WebhookHandlerArgs
} from './handler-deps.js'

type IssueCommentCreatedWebhookEvent = Pick<
  EmitterWebhookEvent<'issue_comment.created'>,
  'id' | 'payload'
> & {
  octokit: Octokit
}

interface HandlerDeps extends TrustedRefHandlerDeps {
  authorizeManualCommentCommandFn?: typeof authorizeManualCommentCommand
  getPullRequestContextFn?: typeof getPullRequestContext
  startIssueReviewCommandFn?: typeof startIssueReviewCommand
  startPullRequestReviewCommandFn?: typeof startPullRequestReviewCommand
  /** Injectable so a test can drive the throttle's clock instead of the process-global default. */
  unmatchedMentionThrottleFn?: (key: string) => boolean
}

// The unrecognised-mention diagnostic is triggered by arbitrary comment text, so it is throttled
// per repository: one line per repro every 5 minutes, remembering at most 200 repos. Without a
// cap, anyone able to comment could turn a diagnostic into an unbounded log stream.
const unmatchedMentionThrottle = createLogThrottle({
  minIntervalMs: 5 * 60_000,
  maxKeys: 200
})

/** The repository full name from the webhook payload, or a stable fallback.
 *
 * The throttle is keyed by repository so a noisy one cannot suppress another's first report. A
 * payload without a repository name falls back to a fixed key, which is acceptable: such an event
 * is malformed and not attributable to a specific repository anyway. */
function mentionThrottleKey(payload: unknown): string {
  const repository =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as { repository?: { full_name?: unknown } }).repository
      : undefined
  const full_name = repository?.full_name
  return typeof full_name === 'string' && full_name.trim() !== ''
    ? full_name.trim().toLowerCase()
    : '(unknown-repository)'
}

export async function handleIssueCommentCreated({
  id,
  octokit,
  payload
}: IssueCommentCreatedWebhookEvent): Promise<void> {
  await handleIssueCommentCreatedWithDeps({ id, octokit, payload })
}

export async function handleIssueCommentCreatedWithDeps(
  { id, octokit, payload }: WebhookHandlerArgs,
  {
    authorizeManualCommentCommandFn = authorizeManualCommentCommand,
    resolveTrustedDefaultBranchFn = resolveTrustedDefaultBranch,
    getPullRequestContextFn = getPullRequestContext,
    startIssueReviewCommandFn = startIssueReviewCommand,
    startPullRequestReviewCommandFn = startPullRequestReviewCommand,
    unmatchedMentionThrottleFn = unmatchedMentionThrottle
  }: HandlerDeps = {}
): Promise<void> {
  if (isSelfOriginatedWebhookEvent(payload)) {
    logSkippedSelfOriginatedEvent('issue_comment.created', payload)
    return
  }

  const commentBody =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as { comment?: { body?: unknown } }).comment?.body
      : null
  const command = extractCommentCommand(commentBody)

  if (!command) {
    // The app answers only `@<slug>` and `@<slug>[bot]`. A comment that addressed some other
    // `@…` spelling would otherwise be dropped with no trace, making a renamed or misspelled
    // mention indistinguishable from "the app is down". Log it as a diagnostic; it is not an
    // error, because most comments mention nobody in particular.
    const mentions = unmatchedMentions(commentBody)
    // Only the first sighting per repository per window is logged; the parse itself still runs
    // so behaviour does not depend on whether the line was emitted.
    if (
      mentions.length > 0 &&
      unmatchedMentionThrottleFn(mentionThrottleKey(payload))
    ) {
      logInfo('workflow_skipped', {
        event: 'issue_comment.created',
        reason: 'comment_mention_not_recognized',
        mentions,
        recognized_mentions: recognizedMentions()
      })
    }
    return
  }

  const issue = extractIssueContext(payload)

  try {
    // Manual comment commands can publish PR reviews, suggestions, commits, or draft PRs;
    // require the commenter to have repository write access before starting any workflow.
    const authorization = await authorizeManualCommentCommandFn({
      octokit,
      owner_login: issue.owner_login,
      repo_name: issue.repo_name,
      sender_login:
        typeof payload === 'object' &&
        payload !== null &&
        !Array.isArray(payload)
          ? (payload as { sender?: { login?: string } }).sender?.login
          : undefined
    })

    if (!authorization.allowed) {
      logInfo('workflow_skipped', {
        event: 'issue_comment.created',
        issue: issue.issue_number,
        permission: authorization.permission,
        reason: 'manual_command_sender_not_authorized',
        repo: issue.repo_full_name,
        sender: authorization.sender_login ?? '(missing)',
        authorization_reason: authorization.reason,
        required_permission: authorization.required_permission
      })
      return
    }

    // Resolve the trusted default branch once for this run; both the issue and
    // PR paths below reuse it instead of re-resolving.
    const trusted_default_branch = await resolveTrustedDefaultBranchFn(
      octokit,
      { owner_login: issue.owner_login, repo_name: issue.repo_name }
    )

    if (issue.is_pull_request) {
      let resolveAdmission: (() => void) | undefined
      const admitted = new Promise<void>((resolve) => {
        resolveAdmission = resolve
      })
      const execution = startPullRequestReviewCommandFn({
        octokit,
        trusted_default_branch,
        preparation_input: {
          kind: 'github_pull_request_review',
          pr_reference: {
            owner_login: issue.owner_login,
            repo_name: issue.repo_name,
            pr_number: issue.issue_number
          },
          trusted_default_branch,
          event_type: 'manual_review',
          test_changes: command.test_changes
        },
        event_type: 'manual_review',
        delivery_id: id,
        test_changes: command.test_changes,
        resolve_pr: async () =>
          await getPullRequestContextFn(octokit, {
            owner_login: issue.owner_login,
            repo_name: issue.repo_name,
            pr_number: issue.issue_number
          }),
        on_admitted: () => {
          resolveAdmission?.()
        }
      })
      backgroundPreparations.start(execution, {
        ingress: 'issue_comment.created',
        issue: issue.issue_number,
        repo: issue.repo_full_name,
        review_target: 'pull-request'
      })
      await Promise.race([admitted, execution])

      return
    }

    let resolveAdmission: (() => void) | undefined
    const admitted = new Promise<void>((resolve) => {
      resolveAdmission = resolve
    })
    const execution = startIssueReviewCommandFn({
      octokit,
      issue,
      trusted_default_branch,
      event_type: 'manual_review',
      delivery_id: id,
      // The GitHub integration always audits an issue: it is an unverified claim. `repair` is
      // only reachable from trusted callers (the PatchEval harness), never from a comment.
      review_objective: 'audit',
      test_changes: command.test_changes,
      open_pr: command.open_pr,
      on_admitted: () => {
        resolveAdmission?.()
      }
    })
    backgroundPreparations.start(execution, {
      ingress: 'issue_comment.created',
      issue: issue.issue_number,
      repo: issue.repo_full_name,
      review_target: 'issue'
    })
    await Promise.race([admitted, execution])
  } catch (error: unknown) {
    const errorInfo = asErrorWithResponse(error)

    logError('webhook_processing_failed', {
      error_message: errorInfo.message,
      event: 'issue_comment.created',
      issue: issue.issue_number,
      repo: issue.repo_full_name
    })

    if (errorInfo.response) {
      logError('webhook_processing_failed', {
        error_message: errorInfo.response.data?.message,
        errors: errorInfo.response.data?.errors,
        event: 'issue_comment.created',
        headers: errorInfo.response.headers,
        status: errorInfo.response.status
      })
    } else {
      logError('webhook_processing_failed', {
        error: errorInfo
      })
    }
  }
}
