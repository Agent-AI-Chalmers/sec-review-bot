import type { EmitterWebhookEvent } from '@octokit/webhooks'

import { logPullRequestPayload } from '../../../utils/log-pull-request.js'
import { startPullRequestReviewCommand } from '../../../triggers/pull-request-review.js'
import { extractPullRequestContext } from '../../../github/pull-request-service.js'
import {
  fetchRepositoryTriggerConfig,
  isAutomaticTriggerModeEnabled,
  isRepositoryTriggerConfigError
} from '../../../github/repo-config-service.js'
import type { GitHubAppOctokit } from '../../../github/octokit.js'
import {
  isSelfOriginatedWebhookEvent,
  logSkippedSelfOriginatedEvent
} from '../../../github/webhook-origin-guard.js'
import { logError, logInfo } from '../../../utils/logger.js'
import { asErrorWithResponse } from '../../../utils/error-utils.js'
import { backgroundPreparations } from '../../../reviews/background-preparations.js'

type PullRequestReadyForReviewWebhookEvent = Pick<
  EmitterWebhookEvent<'pull_request.ready_for_review'>,
  'id' | 'payload'
> & {
  octokit: unknown
}

export async function handlePullRequestReadyForReview({
  id,
  octokit,
  payload
}: PullRequestReadyForReviewWebhookEvent): Promise<void> {
  const pr = extractPullRequestContext(payload)

  logPullRequestPayload(payload)

  if (isSelfOriginatedWebhookEvent(payload)) {
    logSkippedSelfOriginatedEvent('pull_request.ready_for_review', payload)
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
        event: 'pull_request.ready_for_review',
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
      event: 'pull_request.ready_for_review',
      reason: 'trigger_mode_disabled',
      trigger_mode: triggerConfig.trigger_mode
    })
    return
  }

  try {
    let resolveAdmission: (() => void) | undefined
    const admitted = new Promise<void>((resolve) => {
      resolveAdmission = resolve
    })
    const execution = startPullRequestReviewCommand({
      octokit,
      pr,
      event_type: 'ready_for_review',
      delivery_id: id,
      on_admitted: () => {
        resolveAdmission?.()
      }
    })
    backgroundPreparations.start(execution, {
      ingress: 'pull_request.ready_for_review',
      pr: pr.pr_number,
      repo: pr.repo_full_name
    })
    await Promise.race([admitted, execution])
  } catch (error: unknown) {
    const errorInfo = asErrorWithResponse(error)

    logError('webhook_processing_failed', {
      error_message: errorInfo.message,
      event: 'pull_request.ready_for_review',
      pr: pr.pr_number,
      repo: pr.repo_full_name
    })

    if (errorInfo.response) {
      logError('webhook_processing_failed', {
        error_message: errorInfo.response.data?.message,
        errors: errorInfo.response.data?.errors,
        event: 'pull_request.ready_for_review',
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
