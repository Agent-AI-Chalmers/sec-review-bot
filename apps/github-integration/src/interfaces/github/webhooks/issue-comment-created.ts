import type { EmitterWebhookEvent } from '@octokit/webhooks'

import { startIssueReviewCommand } from '../../../triggers/issue-review.js'
import { startPullRequestReviewCommand } from '../../../triggers/pull-request-review.js'
import { extractCommentCommand } from '../../../infrastructure/github/comment-command-service.js'
import { authorizeManualCommentCommand } from '../../../infrastructure/github/manual-command-authorization.js'
import { extractIssueContext } from '../../../infrastructure/github/issue-service.js'
import { getPullRequestContext } from '../../../infrastructure/github/pull-request-service.js'
import type { GitHubAppOctokit } from '../../../infrastructure/github/octokit.js'
import {
  isSelfOriginatedWebhookEvent,
  logSkippedSelfOriginatedEvent
} from '../../../infrastructure/github/webhook-origin-guard.js'
import { logError, logInfo } from '../../../utils/logger.js'
import { asErrorWithResponse } from '../../../utils/error-utils.js'
import { reviewExecutionTracker } from '../../../infrastructure/review-execution-tracker.js'

type IssueCommentCreatedWebhookEvent = Pick<
  EmitterWebhookEvent<'issue_comment.created'>,
  'id' | 'payload'
> & {
  octokit: unknown
}

interface WebhookHandlerArgs {
  id: string
  octokit: unknown
  payload: unknown
}

interface HandlerDeps {
  authorizeManualCommentCommandFn?: typeof authorizeManualCommentCommand
  getPullRequestContextFn?: typeof getPullRequestContext
  startIssueReviewCommandFn?: typeof startIssueReviewCommand
  startPullRequestReviewCommandFn?: typeof startPullRequestReviewCommand
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
    getPullRequestContextFn = getPullRequestContext,
    startIssueReviewCommandFn = startIssueReviewCommand,
    startPullRequestReviewCommandFn = startPullRequestReviewCommand
  }: HandlerDeps = {}
): Promise<void> {
  if (isSelfOriginatedWebhookEvent(payload)) {
    logSkippedSelfOriginatedEvent('issue_comment.created', payload)
    return
  }

  const command = extractCommentCommand(
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as { comment?: { body?: unknown } }).comment?.body
      : null
  )

  if (!command) {
    return
  }

  const issue = extractIssueContext(payload)

  try {
    // Manual comment commands can publish PR reviews, suggestions, commits, or draft PRs;
    // require the commenter to have repository write access before starting any workflow.
    const authorization = await authorizeManualCommentCommandFn({
      octokit: octokit as GitHubAppOctokit,
      owner_login: issue.owner_login,
      repo_name: issue.repo_name,
      sender_login:
        typeof payload === 'object' && payload !== null && !Array.isArray(payload)
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

    if (issue.is_pull_request) {
      if (command.issue_review_objective !== null) {
        return
      }

      let resolveAdmission: (() => void) | undefined
      const admitted = new Promise<void>((resolve) => {
        resolveAdmission = resolve
      })
      const execution = startPullRequestReviewCommandFn({
        octokit,
        event_type: 'manual_review',
        delivery_id: id,
        repair_mode: command.repair_mode,
        // issue_comment only has issue-shaped PR identity. Resolve full refs and
        // SHAs after the delivery has a durable run record.
        resolve_pr: async () =>
          await getPullRequestContextFn(octokit as GitHubAppOctokit, {
            owner_login: issue.owner_login,
            repo_name: issue.repo_name,
            pr_number: issue.issue_number
          }),
        on_admitted: () => {
          resolveAdmission?.()
        }
      })
      reviewExecutionTracker.start(execution, {
        ingress: 'issue_comment.created',
        issue: issue.issue_number,
        repo: issue.repo_full_name,
        review_target: 'pull-request'
      })
      await Promise.race([admitted, execution])

      return
    }

    if (command.issue_review_objective === null) {
      return
    }

    let resolveAdmission: (() => void) | undefined
    const admitted = new Promise<void>((resolve) => {
      resolveAdmission = resolve
    })
    const execution = startIssueReviewCommandFn({
      octokit,
      issue,
      event_type: 'manual_review',
      delivery_id: id,
      review_objective: command.issue_review_objective,
      repair_mode: command.repair_mode,
      on_admitted: () => {
        resolveAdmission?.()
      }
    })
    reviewExecutionTracker.start(execution, {
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
