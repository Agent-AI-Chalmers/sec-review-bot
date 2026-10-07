import type { EmitterWebhookEvent } from '@octokit/webhooks'

import { logPullRequestPayload } from '../../../utils/log-pull-request.js'
import { startPullRequestReviewCommand } from '../../../triggers/pull-request-review.js'
import {
  extractPullRequestContext,
  type PullRequestContext
} from '../../../infrastructure/github/pull-request-service.js'
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
import { logError, logInfo } from '../../../utils/logger.js'
import { asErrorWithResponse } from '../../../utils/error-utils.js'
import { reviewExecutionTracker } from '../../../infrastructure/review-execution-tracker.js'

type PullRequestOpenedWebhookEvent = Pick<
  EmitterWebhookEvent<'pull_request.opened'>,
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
  fetchRepositoryTriggerConfigFn?: typeof fetchRepositoryTriggerConfig
  isAutomaticTriggerModeEnabledFn?: typeof isAutomaticTriggerModeEnabled
  isRepositoryTriggerConfigErrorFn?: typeof isRepositoryTriggerConfigError
  startPullRequestReviewCommandFn?: (args: {
    octokit: WebhookHandlerArgs['octokit']
    pr: PullRequestContext
    event_type: 'opened'
    delivery_id: string
    on_admitted?: (admission: { run_id: string; status: string; replayed: boolean }) => void
  }) => Promise<unknown>
}

export async function handlePullRequestOpened({
  id,
  octokit,
  payload
}: PullRequestOpenedWebhookEvent): Promise<void> {
  await handlePullRequestOpenedWithDeps({ id, octokit, payload })
}

export async function handlePullRequestOpenedWithDeps(
  { id, octokit, payload }: WebhookHandlerArgs,
  {
    fetchRepositoryTriggerConfigFn = fetchRepositoryTriggerConfig,
    isAutomaticTriggerModeEnabledFn = isAutomaticTriggerModeEnabled,
    isRepositoryTriggerConfigErrorFn = isRepositoryTriggerConfigError,
    startPullRequestReviewCommandFn = startPullRequestReviewCommand
  }: HandlerDeps = {}
): Promise<void> {
  // Self-origin checks only need the webhook envelope, so skip before
  // validating workflow-specific pull request fields.
  if (isSelfOriginatedWebhookEvent(payload)) {
    logSkippedSelfOriginatedEvent('pull_request.opened', payload)
    return
  }

  const pr = extractPullRequestContext(payload)

  logPullRequestPayload(payload)

  let triggerConfig
  try {
    triggerConfig = await fetchRepositoryTriggerConfigFn(octokit as GitHubAppOctokit, {
      owner_login: pr.owner_login,
      repo_name: pr.repo_name,
      ref: pr.base_ref
    })
  } catch (error: unknown) {
    if (isRepositoryTriggerConfigErrorFn(error)) {
      logError('repo_trigger_config_failed', {
        event: 'pull_request.opened',
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
      event: 'pull_request.opened',
      reason: 'trigger_mode_disabled',
      trigger_mode: triggerConfig.trigger_mode
    })
    return
  }

  if (pr.is_draft) {
    // Draft PR 在默认策略下不做首次自动审查，
    // 等作者显式切到 ready_for_review 再进入完整 workflow。
    logInfo('workflow_skipped', {
      event: 'pull_request.opened',
      pr: pr.pr_number,
      reason: 'draft_pull_request'
    })
    return
  }

  try {
    let resolveAdmission: (() => void) | undefined
    const admitted = new Promise<void>((resolve) => {
      resolveAdmission = resolve
    })
    const execution = startPullRequestReviewCommandFn({
      octokit,
      pr,
      event_type: 'opened',
      delivery_id: id,
      on_admitted: () => {
        resolveAdmission?.()
      }
    })
    reviewExecutionTracker.start(execution, {
      ingress: 'pull_request.opened',
      pr: pr.pr_number,
      repo: pr.repo_full_name
    })
    await Promise.race([admitted, execution])
  } catch (error: unknown) {
    const errorInfo = asErrorWithResponse(error)

    logError('webhook_processing_failed', {
      error_message: errorInfo.message,
      event: 'pull_request.opened',
      pr: pr.pr_number,
      repo: pr.repo_full_name
    })

    if (errorInfo.response) {
      logError('webhook_processing_failed', {
        error_message: errorInfo.response.data?.message,
        errors: errorInfo.response.data?.errors,
        event: 'pull_request.opened',
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
