import type { EmitterWebhookEvent } from '@octokit/webhooks'

import { logPullRequestPayload } from '../../../utils/log-pull-request.js'
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
import type { Octokit } from 'octokit'
import type { TrustedDefaultBranch } from '../../../github/default-branch-service.js'
import {
  isSelfOriginatedWebhookEvent,
  logSkippedSelfOriginatedEvent
} from '../../../github/webhook-origin-guard.js'
import { logError, logInfo } from '../../../utils/logger.js'
import { asErrorWithResponse } from '../../../utils/error-utils.js'
import { backgroundPreparations } from '../../../reviews/background-preparations.js'
import {
  type TriggerConfigHandlerDeps,
  type WebhookHandlerArgs
} from './handler-deps.js'

type PullRequestReadyForReviewWebhookEvent = Pick<
  EmitterWebhookEvent<'pull_request.ready_for_review'>,
  'id' | 'payload'
> & {
  octokit: Octokit
}

interface HandlerDeps extends TriggerConfigHandlerDeps {
  startPullRequestReviewCommandFn?: (args: {
    octokit: WebhookHandlerArgs['octokit']
    pr: PullRequestContext
    trusted_default_branch: { default_branch: string; head_sha: string }
    event_type: 'synchronize' | 'ready_for_review'
    delivery_id: string
    on_admitted?: (admission: {
      run_id: string
      status: string
      replayed: boolean
    }) => void
  }) => Promise<unknown>
}

export async function handlePullRequestReadyForReview({
  id,
  octokit,
  payload
}: PullRequestReadyForReviewWebhookEvent): Promise<void> {
  await handlePullRequestReadyForReviewWithDeps({ id, octokit, payload })
}

export async function handlePullRequestReadyForReviewWithDeps(
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
    logSkippedSelfOriginatedEvent('pull_request.ready_for_review', payload)
    return
  }

  const pr = extractPullRequestContext(payload)

  logPullRequestPayload(payload)

  // External fork PRs are not auto-reviewed. Approval is an explicit maintainer
  // comment command; a new push invalidates it, so ready_for_review is not an
  // approval signal.
  if (pr.from_fork) {
    logInfo('workflow_skipped', {
      event: 'pull_request.ready_for_review',
      reason: 'fork_pr_requires_approval',
      pr: pr.pr_number,
      repo: pr.repo_full_name,
      head_repo: pr.head_repo_full_name
    })
    return
  }

  let triggerConfig
  let trusted_default_branch: TrustedDefaultBranch
  try {
    // Read config from the API-resolved default branch, via base repo identity
    // (never use pr.base_ref, which is payload-derived).
    const id = resolveTrustedRepositoryIdentity(pr)
    const resolved = await fetchTrustedRepositoryTriggerConfigFn(octokit, id)
    triggerConfig = resolved.config
    trusted_default_branch = {
      default_branch: resolved.default_branch,
      head_sha: resolved.head_sha
    }
  } catch (error: unknown) {
    if (isRepositoryTriggerConfigErrorFn(error)) {
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

  if (!isAutomaticTriggerModeEnabledFn(triggerConfig)) {
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
    const execution = startPullRequestReviewCommandFn({
      octokit,
      trusted_default_branch,
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
