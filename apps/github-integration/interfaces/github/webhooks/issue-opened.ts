import type { EmitterWebhookEvent } from '@octokit/webhooks'

import { startIssueReviewCommand } from '../../../triggers/issue-review.js'
import { extractIssueContext, type IssueContext } from '../../../infrastructure/github/issue-service.js'
import {
  fetchRepositoryTriggerConfig,
  isAutomaticTriggerModeEnabled,
  isRepositoryTriggerConfigError
} from '../../../infrastructure/github/repo-config-service.js'
import type { GitHubAppOctokit } from '../../../infrastructure/github/octokit.js'
import {
  isSelfOriginatedWebhookEvent,
  logSkippedSelfOriginatedEvent
} from '../../../infrastructure/github/webhook-origin-guard.js'
import { logIssuePayload } from '../../../utils/log-issue.js'
import { logError, logInfo } from '../../../utils/logger.js'
import { asErrorWithResponse } from '../../../utils/error-utils.js'

type IssueOpenedWebhookEvent = Pick<EmitterWebhookEvent<'issues.opened'>, 'payload'> & {
  octokit: unknown
}

interface WebhookHandlerArgs {
  octokit: unknown
  payload: unknown
}

interface HandlerDeps {
  fetchRepositoryTriggerConfigFn?: typeof fetchRepositoryTriggerConfig
  isAutomaticTriggerModeEnabledFn?: typeof isAutomaticTriggerModeEnabled
  isRepositoryTriggerConfigErrorFn?: typeof isRepositoryTriggerConfigError
  startIssueReviewCommandFn?: (args: {
    octokit: WebhookHandlerArgs['octokit']
    issue: IssueContext
    event_type: 'opened'
  }) => Promise<unknown>
}

export async function handleIssueOpened ({ octokit, payload }: IssueOpenedWebhookEvent): Promise<void> {
  await handleIssueOpenedWithDeps({ octokit, payload })
}

export async function handleIssueOpenedWithDeps (
  { octokit, payload }: WebhookHandlerArgs,
  {
    fetchRepositoryTriggerConfigFn = fetchRepositoryTriggerConfig,
    isAutomaticTriggerModeEnabledFn = isAutomaticTriggerModeEnabled,
    isRepositoryTriggerConfigErrorFn = isRepositoryTriggerConfigError,
    startIssueReviewCommandFn = startIssueReviewCommand
  }: HandlerDeps = {}
): Promise<void> {
  // Self-origin checks only need the webhook envelope, so skip before
  // validating workflow-specific issue fields.
  if (isSelfOriginatedWebhookEvent(payload)) {
    logSkippedSelfOriginatedEvent('issues.opened', payload)
    return
  }

  const issue = extractIssueContext(payload)

  logIssuePayload(payload)

  if (issue.is_pull_request) {
    logInfo('workflow_skipped', {
      event: 'issues.opened',
      issue: issue.issue_number,
      reason: 'payload_is_pull_request'
    })
    return
  }

  let triggerConfig
  try {
    triggerConfig = await fetchRepositoryTriggerConfigFn(octokit as GitHubAppOctokit, {
      owner_login: issue.owner_login,
      repo_name: issue.repo_name,
      ref: issue.default_branch
    })
  } catch (error: unknown) {
    if (isRepositoryTriggerConfigErrorFn(error)) {
      logError('repo_trigger_config_failed', {
        event: 'issues.opened',
        owner: error.owner_login,
        path: error.path,
        reason: error.reason,
        ref: error.ref,
        repo: error.repo_name
      })
    }
    throw error
  }

  if (!isAutomaticTriggerModeEnabledFn(triggerConfig)) {
    logInfo('workflow_skipped', {
      event: 'issues.opened',
      reason: 'trigger_mode_disabled',
      trigger_mode: triggerConfig.trigger_mode
    })
    return
  }

  try {
    await startIssueReviewCommandFn({ octokit, issue, event_type: 'opened' })
  } catch (error: unknown) {
    const errorInfo = asErrorWithResponse(error)

    logError('webhook_processing_failed', {
      error_message: errorInfo.message,
      event: 'issues.opened',
      issue: issue.issue_number,
      repo: issue.repo_full_name
    })

    if (errorInfo.response) {
      logError('webhook_processing_failed', {
        error_message: errorInfo.response.data?.message,
        errors: errorInfo.response.data?.errors,
        event: 'issues.opened',
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
