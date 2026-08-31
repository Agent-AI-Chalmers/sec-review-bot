import type { IssueContext } from '../infrastructure/github/issue-service.js'
import { issueReviewPublishContext } from '../infrastructure/runner/publish-context.js'
import { runnerRunStore } from '../infrastructure/runner/run-store.js'
import {
  startIssueReviewRun,
  type SubmittedIssueReviewRun
} from '../reviews/issues/submit.js'
import type { RepairMode } from '../infrastructure/runner/input.js'

type IssueReviewEventType = 'opened' | 'manual_review'
type StartIssueReview = typeof startIssueReviewRun
type IssueReviewRunStore = Pick<typeof runnerRunStore, 'save_queued_run'>

interface StartIssueReviewCommandDeps {
  start_review: StartIssueReview
  store: IssueReviewRunStore
}

interface StartIssueReviewCommandArgs {
  octokit: unknown
  issue: IssueContext
  event_type: IssueReviewEventType
  review_objective?: 'audit' | 'repair' | null
  repair_mode?: RepairMode | null
  deps?: Partial<StartIssueReviewCommandDeps>
}

export async function startIssueReviewCommand ({
  octokit,
  issue,
  event_type,
  review_objective = 'audit',
  repair_mode = null,
  deps = {}
}: StartIssueReviewCommandArgs): Promise<SubmittedIssueReviewRun> {
  const {
    start_review = startIssueReviewRun,
    store = runnerRunStore
  } = deps
  const submitted = await start_review({
    octokit,
    issue,
    event_type,
    review_objective: event_type === 'opened' ? 'audit' : review_objective,
    repair_mode: event_type === 'opened' ? null : repair_mode
  })

  store.save_queued_run({
    workflow: 'issue-review',
    run_id: submitted.run_id,
    publish_context: issueReviewPublishContext(submitted)
  })

  return submitted
}
