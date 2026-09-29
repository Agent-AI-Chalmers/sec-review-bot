import type { PullRequestContext } from '../infrastructure/github/pull-request-service.js'
import { pullRequestReviewPublishContext } from '../infrastructure/runner/publish-context.js'
import { reviewRunStore } from '../infrastructure/runner/review-store.js'
import { createRunId } from '../reviews/shared/input-bundle.js'
import type { RepairMode } from '../infrastructure/runner/input.js'
import { RunnerSubmissionUncertainError } from '../infrastructure/runner/client.js'
import {
  startPullRequestReviewRun,
  type SubmittedPullRequestReviewRun
} from '../reviews/pull-requests/submit.js'

type PullRequestReviewEventType = 'opened' | 'ready_for_review' | 'synchronize' | 'manual_review'
type StartPullRequestReview = typeof startPullRequestReviewRun
type PullRequestReviewRunStore = Pick<
  typeof reviewRunStore,
  'admit_review_run' | 'mark_queued' | 'markFailed'
>

interface StartPullRequestReviewCommandDeps {
  start_review: StartPullRequestReview
  store: PullRequestReviewRunStore
  create_run_id: typeof createRunId
}

interface StartPullRequestReviewCommandArgs {
  octokit: unknown
  pr?: PullRequestContext
  resolve_pr?: () => Promise<PullRequestContext>
  event_type: PullRequestReviewEventType
  repair_mode?: RepairMode | null
  delivery_id: string
  on_admitted?: (admission: { run_id: string, status: string, replayed: boolean }) => void
  deps?: Partial<StartPullRequestReviewCommandDeps>
}

interface StartedPullRequestReview {
  run_id: string
}

export async function startPullRequestReviewCommand ({
  octokit,
  pr,
  resolve_pr,
  event_type,
  repair_mode = null,
  delivery_id,
  on_admitted,
  deps = {}
}: StartPullRequestReviewCommandArgs): Promise<StartedPullRequestReview> {
  const {
    start_review = startPullRequestReviewRun,
    store = reviewRunStore,
    create_run_id = createRunId
  } = deps
  const candidate_run_id = create_run_id()
  const run = {
    workflow: 'pull-request-review',
    run_id: candidate_run_id,
    publish_context: {}
  } as const
  const admission = store.admit_review_run({
    ...run,
    ingress_kind: 'github_webhook',
    ingress_key: delivery_id
  })
  if (!admission.created) {
    on_admitted?.({ run_id: admission.record.run_id, status: admission.record.status, replayed: true })
    return { run_id: admission.record.run_id }
  }
  const run_id = admission.record.run_id
  on_admitted?.({ run_id, status: 'preparing', replayed: false })

  let submitted: SubmittedPullRequestReviewRun
  try {
    const resolvedPr = pr ?? await resolve_pr?.()
    if (resolvedPr === undefined) {
      throw new Error('Pull request context is missing after admission.')
    }
    submitted = await start_review({
      octokit,
      pr: resolvedPr,
      run_id,
      event_type,
      repair_mode: event_type === 'manual_review' ? repair_mode : null
    })
  } catch (error) {
    store.markFailed(run_id, {
      // A lost Runner response is recoverable by replaying the same run_id;
      // PR context and input preparation failures remain terminal.
      code: error instanceof RunnerSubmissionUncertainError ? 'SUBMISSION_STATE_UNCERTAIN' : 'REVIEW_START_FAILED',
      message: error instanceof Error ? error.message : String(error)
    })
    throw error
  }

  try {
    store.mark_queued(run_id, pullRequestReviewPublishContext(submitted))
  } catch (error) {
    store.markFailed(run_id, {
      code: 'SUBMISSION_STATE_UNCERTAIN',
      message: `Runner accepted the run, but its queued state was not recorded: ${error instanceof Error ? error.message : String(error)}`
    })
    throw error
  }

  return submitted
}
