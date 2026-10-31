// Turns a pull-request review request into a durable run and preserves enough
// connector input to resume preparation after an integration restart.
import type { Octokit } from 'octokit'

import type { TestChangesPolicy } from '../execution/input.js'
import type { TrustedDefaultBranch } from '../github/default-branch-service.js'
import type { PullRequestContext } from '../github/pull-request-service.js'
import { reviewRunsClient } from '../review-runs/client.js'
import { pullRequestReviewPublishContext } from '../review-runs/publish-context.js'
import {
  preparePullRequestReview,
  type PreparedPullRequestReviewRun
} from '../reviews/pull-requests/prepare-review.js'
import {
  runPreparationCommand,
  type ClaimedPreparation,
  type PreparationAdmission,
  type PreparationCommandStore
} from './preparation-command.js'

import type {
  PullRequestReviewEventType,
  PullRequestPreparationInput
} from '../review-runs/preparation-input.js'

interface StartPullRequestReviewCommandDeps {
  prepare_review: typeof preparePullRequestReview
  store: PreparationCommandStore
}

interface StartPullRequestReviewCommandArgs {
  octokit: Octokit
  pr?: PullRequestContext
  resolve_pr?: () => Promise<PullRequestContext>
  trusted_default_branch: TrustedDefaultBranch
  event_type: PullRequestReviewEventType
  // The PR path's only policy knob. The objective is fixed to `audit`, but an
  // audit review still reaches mitigation once a defect is confirmed, so the
  // patch-level test-changes constraint stays meaningful here.
  test_changes?: TestChangesPolicy | null
  delivery_id: string
  preparation_input?: Record<string, unknown>
  claimed_preparation?: ClaimedPreparation
  on_admitted?: (admission: {
    run_id: string
    status: string
    replayed: boolean
  }) => void
  deps?: Partial<StartPullRequestReviewCommandDeps>
}

interface StartedPullRequestReview {
  run_id: string
}

export async function startPullRequestReviewCommand({
  octokit,
  pr,
  resolve_pr,
  trusted_default_branch,
  event_type,
  test_changes = null,
  delivery_id,
  preparation_input,
  claimed_preparation,
  on_admitted,
  deps = {}
}: StartPullRequestReviewCommandArgs): Promise<StartedPullRequestReview> {
  const {
    prepare_review = preparePullRequestReview,
    store = reviewRunsClient
  } = deps
  const durableInput =
    preparation_input ??
    (pr === undefined
      ? undefined
      : ({
          kind: 'github_pull_request_review',
          pr,
          trusted_default_branch,
          event_type,
          test_changes
        } satisfies PullRequestPreparationInput))
  if (durableInput === undefined)
    throw new Error('Pull request preparation input is required for admission.')
  const admission: PreparationAdmission = {
    workflow: 'pull-request-review',
    ingress_key: delivery_id,
    preparation_input: durableInput
  }
  return await runPreparationCommand<PreparedPullRequestReviewRun>({
    store,
    admission,
    ...(claimed_preparation === undefined ? {} : { claimed_preparation }),
    ...(on_admitted === undefined ? {} : { on_admitted }),
    publish_context: pullRequestReviewPublishContext,
    prepare_review: async ({ run_id, checkpoint }) => {
      // Admission happens before PR lookup, input preparation, and Execution
      // submission. Any failure below therefore remains attached to this run_id
      // instead of becoming an untracked pre-run error.
      const resolvedPr = pr ?? (await resolve_pr?.())
      if (resolvedPr === undefined)
        throw new Error('Pull request context is missing after admission.')
      if (durableInput.pr === undefined) {
        // The initial comment webhook has only a PR reference. Once that reference
        // resolves, checkpoint the full connector input before expensive preparation
        // so a crash resumes this PR snapshot instead of resolving a newer head.
        await checkpoint({ ...durableInput, pr: resolvedPr })
      }
      return await prepare_review({
        octokit,
        pr: resolvedPr,
        trusted_default_branch,
        run_id,
        event_type,
        test_changes: event_type === 'manual_review' ? test_changes : null
      })
    }
  })
}
