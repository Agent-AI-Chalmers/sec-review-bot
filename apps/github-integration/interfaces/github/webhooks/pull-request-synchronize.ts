import type { EmitterWebhookEvent } from '@octokit/webhooks'

import { startPullRequestReviewCommand } from '../../../triggers/pull-request-review.js'
import { extractPullRequestContext } from '../../../infrastructure/github/pull-request-service.js'
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
import { logPullRequestPayload } from '../../../utils/log-pull-request.js'
import { logError, logInfo } from '../../../utils/logger.js'
import { asErrorWithResponse } from '../../../utils/error-utils.js'

type PullRequestSynchronizeWebhookEvent = Pick<EmitterWebhookEvent<'pull_request.synchronize'>, 'payload'> & {
  octokit: unknown
}

export async function handlePullRequestSynchronize ({ octokit, payload }: PullRequestSynchronizeWebhookEvent): Promise<void> {
  const pr = extractPullRequestContext(payload)

  logPullRequestPayload(payload)

  if (isSelfOriginatedWebhookEvent(payload)) {
    logSkippedSelfOriginatedEvent('pull_request.synchronize', payload)
    return
  }

  let triggerConfig
  try {
    triggerConfig = await fetchRepositoryTriggerConfig(octokit as GitHubAppOctokit, {
      owner_login: pr.owner_login,
      repo_name: pr.repo_name,
      ref: pr.base_ref
    })
  } catch (error: unknown) {
    if (isRepositoryTriggerConfigError(error)) {
      logError('repo_trigger_config_failed', {
        event: 'pull_request.synchronize',
        owner: error.owner_login,
        path: error.path,
        reason: error.reason,
        ref: error.ref,
        repo: error.repo_name
      })
    }
    throw error
  }

  if (!isAutomaticTriggerModeEnabled(triggerConfig)) {
    logInfo('workflow_skipped', {
      event: 'pull_request.synchronize',
      reason: 'trigger_mode_disabled',
      trigger_mode: triggerConfig.trigger_mode
    })
    return
  }

  if (pr.is_draft) {
    // Draft PRs do not participate in automatic incremental review before
    // ready_for_review, so the bot does not repeatedly intervene mid-work.
    logInfo('workflow_skipped', {
      event: 'pull_request.synchronize',
      pr: pr.pr_number,
      reason: 'draft_pull_request'
    })
    return
  }

  try {
    await startPullRequestReviewCommand({ octokit, pr, event_type: 'synchronize' })
  } catch (error: unknown) {
    const errorInfo = asErrorWithResponse(error)

    logError('webhook_processing_failed', {
      error_message: errorInfo.message,
      event: 'pull_request.synchronize',
      pr: pr.pr_number,
      repo: pr.repo_full_name
    })

    if (errorInfo.response) {
      logError('webhook_processing_failed', {
        error_message: errorInfo.response.data?.message,
        errors: errorInfo.response.data?.errors,
        event: 'pull_request.synchronize',
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
