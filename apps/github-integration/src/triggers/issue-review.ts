// Turns an issue review request into a durable run, fencing preparation until
// the Execution submission boundary has been crossed.
import type { Octokit } from 'octokit'

import type { TestChangesPolicy } from '../execution/input.js'
import type { TrustedDefaultBranch } from '../github/default-branch-service.js'
import type { IssueContext } from '../github/issue-service.js'
import { reviewRunsClient } from '../review-runs/client.js'
import { issueReviewPublishContext } from '../review-runs/publish-context.js'
import {
  prepareIssueReview,
  type PreparedIssueReviewRun
} from '../reviews/issues/prepare-review.js'
import {
  runPreparationCommand,
  type ClaimedPreparation,
  type PreparationAdmission,
  type PreparationCommandStore
} from './preparation-command.js'

type IssueReviewEventType = 'opened' | 'manual_review'
interface StartIssueReviewCommandDeps {
  prepare_review: typeof prepareIssueReview
  store: PreparationCommandStore
}

interface StartIssueReviewCommandArgs {
  octokit: Octokit
  issue: IssueContext
  trusted_default_branch: TrustedDefaultBranch
  event_type: IssueReviewEventType
  review_objective?: 'audit' | 'repair' | null
  test_changes?: TestChangesPolicy | null
  open_pr?: boolean | null
  delivery_id: string
  claimed_preparation?: ClaimedPreparation
  on_admitted?: (admission: {
    run_id: string
    status: string
    replayed: boolean
  }) => void
  deps?: Partial<StartIssueReviewCommandDeps>
}

interface StartedIssueReview {
  run_id: string
}

export async function startIssueReviewCommand({
  octokit,
  issue,
  trusted_default_branch,
  event_type,
  review_objective = 'audit',
  test_changes = null,
  open_pr = false,
  delivery_id,
  claimed_preparation,
  on_admitted,
  deps = {}
}: StartIssueReviewCommandArgs): Promise<StartedIssueReview> {
  const { prepare_review = prepareIssueReview, store = reviewRunsClient } = deps
  // Automatic triggers have no per-run comment to opt in, so they never open a PR, and an
  // opened issue is always an audit rather than a requested repair.
  const admission: PreparationAdmission = {
    workflow: 'issue-review',
    ingress_key: delivery_id,
    preparation_input: {
      kind: 'github_issue_review',
      issue,
      trusted_default_branch,
      event_type,
      review_objective,
      test_changes,
      open_pr
    }
  }
  const started = await runPreparationCommand<PreparedIssueReviewRun>({
    store,
    admission,
    ...(claimed_preparation === undefined ? {} : { claimed_preparation }),
    ...(on_admitted === undefined ? {} : { on_admitted }),
    publish_context: issueReviewPublishContext,
    prepare_review: async ({ run_id }) =>
      await prepare_review({
        octokit,
        issue,
        trusted_default_branch,
        run_id,
        event_type,
        review_objective: event_type === 'opened' ? 'audit' : review_objective,
        test_changes: event_type === 'opened' ? null : test_changes,
        open_pr: event_type === 'opened' ? false : open_pr
      })
  })
  return started
}
