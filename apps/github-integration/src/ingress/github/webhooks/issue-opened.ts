import type { EmitterWebhookEvent } from '@octokit/webhooks'

import { startIssueReviewCommand } from '../../../triggers/issue-review.js'
import {
  extractIssueContext,
  type IssueContext
} from '../../../github/issue-service.js'
import {
  fetchTrustedRepositoryTriggerConfig,
  isAutomaticTriggerModeEnabled,
  isRepositoryTriggerConfigError
} from '../../../github/repo-config-service.js'
import type { GitHubAppOctokit } from '../../../github/octokit.js'
import type { TrustedDefaultBranch } from '../../../github/default-branch-service.js'
import {
  isSelfOriginatedWebhookEvent,
  logSkippedSelfOriginatedEvent
} from '../../../github/webhook-origin-guard.js'
import { logIssuePayload } from '../../../utils/log-issue.js'
import { logError, logInfo } from '../../../utils/logger.js'
import { asErrorWithResponse } from '../../../utils/error-utils.js'
import { backgroundPreparations } from '../../../reviews/background-preparations.js'
import {
  type TriggerConfigHandlerDeps,
  type WebhookHandlerArgs
} from './handler-deps.js'

type IssueOpenedWebhookEvent = Pick<
  EmitterWebhookEvent<'issues.opened'>,
  'id' | 'payload'
> & {
  octokit: unknown
}

interface HandlerDeps extends TriggerConfigHandlerDeps {
  startIssueReviewCommandFn?: (args: {
    octokit: WebhookHandlerArgs['octokit']
    issue: IssueContext
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

export async function handleIssueOpened({
  id,
  octokit,
  payload
}: IssueOpenedWebhookEvent): Promise<void> {
  await handleIssueOpenedWithDeps({ id, octokit, payload })
}

export async function handleIssueOpenedWithDeps(
  { id, octokit, payload }: WebhookHandlerArgs,
  {
    fetchTrustedRepositoryTriggerConfigFn = fetchTrustedRepositoryTriggerConfig,
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
  let trusted_default_branch: TrustedDefaultBranch
  try {
    // Resolve the trusted default branch via API, once for this run, and read
    // config from it (A1: do not trust the payload's repository.default_branch).
    const resolved = await fetchTrustedRepositoryTriggerConfigFn(
      octokit as GitHubAppOctokit,
      {
        owner_login: issue.owner_login,
        repo_name: issue.repo_name
      }
    )
    triggerConfig = resolved.config
    trusted_default_branch = {
      default_branch: resolved.default_branch,
      head_sha: resolved.head_sha
    }
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
    let resolveAdmission: (() => void) | undefined
    const admitted = new Promise<void>((resolve) => {
      resolveAdmission = resolve
    })
    const execution = startIssueReviewCommandFn({
      octokit,
      issue,
      trusted_default_branch,
      event_type: 'opened',
      delivery_id: id,
      on_admitted: () => {
        resolveAdmission?.()
      }
    })
    backgroundPreparations.start(execution, {
      ingress: 'issues.opened',
      issue: issue.issue_number,
      repo: issue.repo_full_name
    })
    await Promise.race([admitted, execution])
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
