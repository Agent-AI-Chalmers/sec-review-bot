// Turns an issue review request into a durable run, fencing preparation until
// the Execution submission boundary has been crossed.
import type { Octokit } from 'octokit'

import type { TestChangesPolicy } from '../execution/input.js'
import type { TrustedDefaultBranch } from '../github/default-branch-service.js'
import type { IssueContext } from '../github/issue-service.js'
import { reviewRunsClient } from '../review-runs/client.js'
import { issueReviewPublishContext } from '../review-runs/publish-context.js'
import {
  startIssueReviewRun,
  type SubmittedIssueReviewRun
} from '../reviews/issues/submit.js'
import {
  runPreparationCommand,
  type ClaimedPreparation,
  type PreparationAdmission
} from './preparation-command.js'

type IssueReviewEventType = 'opened' | 'manual_review'
type StartIssueReview = typeof startIssueReviewRun
type IssueReviewReviewRunsClient = {
  admitReviewRun: (
    ...args: Parameters<typeof reviewRunsClient.admitReviewRun>
  ) =>
    | Awaited<ReturnType<typeof reviewRunsClient.admitReviewRun>>
    | ReturnType<typeof reviewRunsClient.admitReviewRun>
  failPreparation: (
    ...args: Parameters<typeof reviewRunsClient.failPreparation>
  ) => unknown
  submitPreparedRun: (
    ...args: Parameters<typeof reviewRunsClient.submitPreparedRun>
  ) => unknown
  renewPreparationClaim: (
    ...args: Parameters<typeof reviewRunsClient.renewPreparationClaim>
  ) => Promise<boolean>
  preparationHeartbeatIntervalMs: typeof reviewRunsClient.preparationHeartbeatIntervalMs
}
interface StartIssueReviewCommandDeps {
  start_review: StartIssueReview
  store: IssueReviewReviewRunsClient
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
  const { start_review = startIssueReviewRun, store = reviewRunsClient } = deps
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
  const started = await runPreparationCommand<
    SubmittedIssueReviewRun,
    SubmittedIssueReviewRun
  >({
    store,
    admission,
    ...(claimed_preparation === undefined ? {} : { claimed_preparation }),
    ...(on_admitted === undefined ? {} : { on_admitted }),
    publish_context: issueReviewPublishContext,
    start_review: async ({ run_id, on_prepared }) =>
      await start_review({
        octokit,
        issue,
        trusted_default_branch,
        run_id,
        event_type,
        review_objective: event_type === 'opened' ? 'audit' : review_objective,
        test_changes: event_type === 'opened' ? null : test_changes,
        open_pr: event_type === 'opened' ? false : open_pr,
        on_prepared
      })
  })
  return started
}
