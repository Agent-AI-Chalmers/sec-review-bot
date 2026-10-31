// Turns a pull-request review request into a durable run and preserves enough
// connector input to resume preparation after an integration restart.
import type { Octokit } from 'octokit'

import type { TestChangesPolicy } from '../execution/input.js'
import type { TrustedDefaultBranch } from '../github/default-branch-service.js'
import {
  getPullRequestContext,
  type PullRequestContext
} from '../github/pull-request-service.js'
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
  PullRequestPreparationInput,
  PullRequestReference
} from '../review-runs/preparation-input.js'

interface StartPullRequestReviewCommandDeps {
  prepare_review: typeof preparePullRequestReview
  store: PreparationCommandStore
  get_pull_request_context: typeof getPullRequestContext
}

type StartPullRequestReviewCommandArgs = {
  octokit: Octokit
  trusted_default_branch: TrustedDefaultBranch
  event_type: PullRequestReviewEventType
  // The PR path's only policy knob. The objective is fixed to `audit`, but an
  // audit review still reaches mitigation once a defect is confirmed, so the
  // patch-level test-changes constraint stays meaningful here.
  test_changes?: TestChangesPolicy | null
  delivery_id: string
  claimed_preparation?: ClaimedPreparation
  on_admitted?: (admission: {
    run_id: string
    status: string
    replayed: boolean
  }) => void
  deps?: Partial<StartPullRequestReviewCommandDeps>
} & (
  | { pr: PullRequestContext; pr_reference?: never }
  | { pr_reference: PullRequestReference; pr?: never }
)

interface StartedPullRequestReview {
  run_id: string
}

export async function startPullRequestReviewCommand({
  octokit,
  pr,
  pr_reference,
  trusted_default_branch,
  event_type,
  test_changes = null,
  delivery_id,
  claimed_preparation,
  on_admitted,
  deps = {}
}: StartPullRequestReviewCommandArgs): Promise<StartedPullRequestReview> {
  const {
    prepare_review = preparePullRequestReview,
    get_pull_request_context = getPullRequestContext,
    store = reviewRunsClient
  } = deps
  const commonInput = {
    kind: 'github_pull_request_review' as const,
    trusted_default_branch,
    event_type,
    test_changes
  }
  const durableInput: PullRequestPreparationInput =
    pr === undefined ? { ...commonInput, pr_reference } : { ...commonInput, pr }
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
      const resolvedPr =
        pr ?? (await get_pull_request_context(octokit, pr_reference))
      if (pr === undefined) {
        // Capture the resolved snapshot before expensive work. Recovery follows the
        // same path, so subsequent attempts never silently move to a newer HEAD.
        await checkpoint({
          ...commonInput,
          pr: resolvedPr
        } satisfies PullRequestPreparationInput)
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
