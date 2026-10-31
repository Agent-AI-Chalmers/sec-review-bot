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

type PullRequestOpenedWebhookEvent = Pick<
  EmitterWebhookEvent<'pull_request.opened'>,
  'id' | 'payload'
> & {
  octokit: Octokit
}

interface HandlerDeps extends TriggerConfigHandlerDeps {
  startPullRequestReviewCommandFn?: (args: {
    octokit: WebhookHandlerArgs['octokit']
    pr: PullRequestContext
    trusted_default_branch: { default_branch: string; head_sha: string }
    event_type: 'opened'
    delivery_id: string
    on_admitted?: (admission: {
      run_id: string
      status: string
      replayed: boolean
    }) => void
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
    fetchTrustedRepositoryTriggerConfigFn = fetchTrustedRepositoryTriggerConfig,
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

  // External fork code is not part of the trusted repository's controlled
  // surface. Do not auto-review; wait for an explicit maintainer action
  // (ready_for_review / comment command).
  if (pr.from_fork) {
    logInfo('workflow_skipped', {
      event: 'pull_request.opened',
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
    // Resolve the trusted default branch via API and read config from it
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
    // Skip the initial automatic review for draft PRs; wait until the author
    // explicitly marks the PR ready_for_review before starting a full review.
    logInfo('workflow_skipped', {
      event: 'pull_request.opened',
      pr: pr.pr_number,
      reason: 'draft_pull_request'
    })
    return
  }

  try {
    await backgroundPreparations.startAndWaitForAdmission(
      (on_admitted) =>
        startPullRequestReviewCommandFn({
          octokit,
          trusted_default_branch,
          pr,
          event_type: 'opened',
          delivery_id: id,
          on_admitted
        }),
      {
        ingress: 'pull_request.opened',
        pr: pr.pr_number,
        repo: pr.repo_full_name
      }
    )
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
