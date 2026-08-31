import type { PullRequestContext } from '../infrastructure/github/pull-request-service.js'
import { pullRequestReviewPublishContext } from '../infrastructure/runner/publish-context.js'
import { runnerRunStore } from '../infrastructure/runner/run-store.js'
import type { RepairMode } from '../infrastructure/runner/input.js'
import {
  startPullRequestReviewRun,
  type SubmittedPullRequestReviewRun
} from '../reviews/pull-requests/submit.js'

type PullRequestReviewEventType = 'opened' | 'ready_for_review' | 'synchronize' | 'manual_review'
type StartPullRequestReview = typeof startPullRequestReviewRun
type PullRequestReviewRunStore = Pick<typeof runnerRunStore, 'save_queued_run'>

interface StartPullRequestReviewCommandDeps {
  start_review: StartPullRequestReview
  store: PullRequestReviewRunStore
}

interface StartPullRequestReviewCommandArgs {
  octokit: unknown
  pr: PullRequestContext
  event_type: PullRequestReviewEventType
  repair_mode?: RepairMode | null
  deps?: Partial<StartPullRequestReviewCommandDeps>
}

export async function startPullRequestReviewCommand ({
  octokit,
  pr,
  event_type,
  repair_mode = null,
  deps = {}
}: StartPullRequestReviewCommandArgs): Promise<SubmittedPullRequestReviewRun> {
  const {
    start_review = startPullRequestReviewRun,
    store = runnerRunStore
  } = deps
  const submitted = await start_review({
    octokit,
    pr,
    event_type,
    repair_mode: event_type === 'manual_review' ? repair_mode : null
  })

  store.save_queued_run({
    workflow: 'pull-request-review',
    run_id: submitted.run_id,
    publish_context: pullRequestReviewPublishContext(submitted)
  })

  return submitted
}
