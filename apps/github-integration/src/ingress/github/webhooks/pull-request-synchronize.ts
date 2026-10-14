import type { EmitterWebhookEvent } from '@octokit/webhooks'

import { startPullRequestReviewCommand } from '../../../triggers/pull-request-review.js'
import {
  extractPullRequestContext,
  resolveTrustedRepositoryIdentity,
  type PullRequestContext
} from '../../../github/pull-request-service.js'
import {
  fetchTrustedRepositoryTriggerConfig,
  isAutomaticTriggerModeEnabled,
  isRepositoryTriggerConfigError
} from '../../../github/repo-config-service.js'
import type { GitHubAppOctokit } from '../../../github/octokit.js'
import {
  isSelfOriginatedWebhookEvent,
  logSkippedSelfOriginatedEvent
} from '../../../github/webhook-origin-guard.js'
import { logPullRequestPayload } from '../../../utils/log-pull-request.js'
import { logError, logInfo } from '../../../utils/logger.js'
import { asErrorWithResponse } from '../../../utils/error-utils.js'
import { backgroundPreparations } from '../../../reviews/background-preparations.js'
import { type TriggerConfigHandlerDeps, type WebhookHandlerArgs } from './handler-deps.js'

type PullRequestSynchronizeWebhookEvent = Pick<
  EmitterWebhookEvent<'pull_request.synchronize'>,
  'id' | 'payload'
> & {
  octokit: unknown
}

interface HandlerDeps extends TriggerConfigHandlerDeps {
  startPullRequestReviewCommandFn?: (args: {
    octokit: WebhookHandlerArgs['octokit']
    pr: PullRequestContext
    event_type: 'synchronize' | 'ready_for_review'
    delivery_id: string
    on_admitted?: (admission: { run_id: string; status: string; replayed: boolean }) => void
  }) => Promise<unknown>
}

export async function handlePullRequestSynchronize({
  id,
  octokit,
  payload
}: PullRequestSynchronizeWebhookEvent): Promise<void> {
  await handlePullRequestSynchronizeWithDeps({ id, octokit, payload })
}

export async function handlePullRequestSynchronizeWithDeps(
  { id, octokit, payload }: WebhookHandlerArgs,
  {
    fetchTrustedRepositoryTriggerConfigFn = fetchTrustedRepositoryTriggerConfig,
    isAutomaticTriggerModeEnabledFn = isAutomaticTriggerModeEnabled,
    isRepositoryTriggerConfigErrorFn = isRepositoryTriggerConfigError,
    startPullRequestReviewCommandFn = startPullRequestReviewCommand
  }: HandlerDeps = {}
): Promise<void> {
  // Self-origin checks only need the webhook envelope, so skip before validating
  // workflow-specific pull request fields (mirrors pull_request.opened). A
  // self-originated payload with missing fields would otherwise throw out of
  // extractPullRequestContext instead of being skipped cleanly.
  if (isSelfOriginatedWebhookEvent(payload)) {
    logSkippedSelfOriginatedEvent('pull_request.synchronize', payload)
    return
  }

  const pr = extractPullRequestContext(payload)

  logPullRequestPayload(payload)

  // Synchronize is a push-driven event; do not auto-review fork PRs. An
  // explicit maintainer action (ready_for_review) is the approval entry point.
  if (pr.from_fork) {
    logInfo('workflow_skipped', {
      event: 'pull_request.synchronize',
      reason: 'fork_pr_requires_approval',
      pr: pr.pr_number,
      repo: pr.repo_full_name,
      head_repo: pr.head_repo_full_name
    })
    return
  }

  let triggerConfig
  try {
    // Read config from the API-resolved default branch, via base repo identity
    // (never use pr.base_ref, which is payload-derived).
    const id = resolveTrustedRepositoryIdentity(pr)
    triggerConfig = (await fetchTrustedRepositoryTriggerConfigFn(octokit as GitHubAppOctokit, id))
      .config
  } catch (error: unknown) {
    if (isRepositoryTriggerConfigErrorFn(error)) {
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

  if (!isAutomaticTriggerModeEnabledFn(triggerConfig)) {
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
    let resolveAdmission: (() => void) | undefined
    const admitted = new Promise<void>((resolve) => {
      resolveAdmission = resolve
    })
    const execution = startPullRequestReviewCommandFn({
      octokit,
      pr,
      event_type: 'synchronize',
      delivery_id: id,
      on_admitted: () => {
        resolveAdmission?.()
      }
    })
    backgroundPreparations.start(execution, {
      ingress: 'pull_request.synchronize',
      pr: pr.pr_number,
      repo: pr.repo_full_name
    })
    await Promise.race([admitted, execution])
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
