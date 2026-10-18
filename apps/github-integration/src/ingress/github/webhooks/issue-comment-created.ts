// Handles authorized GitHub issue-comment commands and starts the appropriate
// durable review workflow without making webhook delivery own long-running work.
import type { EmitterWebhookEvent } from '@octokit/webhooks'

import { startIssueReviewCommand } from '../../../triggers/issue-review.js'
import { startPullRequestReviewCommand } from '../../../triggers/pull-request-review.js'
import { extractCommentCommand } from '../../../github/comment-command-service.js'
import { authorizeManualCommentCommand } from '../../../github/manual-command-authorization.js'
import { extractIssueContext } from '../../../github/issue-service.js'
import { getPullRequestContext } from '../../../github/pull-request-service.js'
import { resolveTrustedDefaultBranch } from '../../../github/default-branch-service.js'
import type { GitHubAppOctokit } from '../../../github/octokit.js'
import {
  isSelfOriginatedWebhookEvent,
  logSkippedSelfOriginatedEvent
} from '../../../github/webhook-origin-guard.js'
import { logError, logInfo } from '../../../utils/logger.js'
import { asErrorWithResponse } from '../../../utils/error-utils.js'
import { backgroundPreparations } from '../../../reviews/background-preparations.js'
import {
  type TrustedRefHandlerDeps,
  type WebhookHandlerArgs
} from './handler-deps.js'

type IssueCommentCreatedWebhookEvent = Pick<
  EmitterWebhookEvent<'issue_comment.created'>,
  'id' | 'payload'
> & {
  octokit: unknown
}

interface HandlerDeps extends TrustedRefHandlerDeps {
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
    resolveTrustedDefaultBranchFn = resolveTrustedDefaultBranch,
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
      octokit as GitHubAppOctokit,
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
          await getPullRequestContextFn(octokit as GitHubAppOctokit, {
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
