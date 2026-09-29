import type { IssueContext } from '../infrastructure/github/issue-service.js'
import { issueReviewPublishContext } from '../infrastructure/runner/publish-context.js'
import {
  startIssueReviewRun,
  type SubmittedIssueReviewRun
} from '../reviews/issues/submit.js'
import type { RepairMode } from '../infrastructure/runner/input.js'
import { createRunId } from '../reviews/shared/input-bundle.js'
import { reviewRunStore } from '../infrastructure/runner/review-store.js'
import { RunnerSubmissionUncertainError } from '../infrastructure/runner/client.js'

type IssueReviewEventType = 'opened' | 'manual_review'
type StartIssueReview = typeof startIssueReviewRun
interface StartIssueReviewCommandDeps {
  start_review: StartIssueReview
  store: Pick<typeof reviewRunStore, 'admit_review_run' | 'mark_queued' | 'markFailed'>
  create_run_id: typeof createRunId
}

interface StartIssueReviewCommandArgs {
  octokit: unknown
  issue: IssueContext
  event_type: IssueReviewEventType
  review_objective?: 'audit' | 'repair' | null
  repair_mode?: RepairMode | null
  delivery_id: string
  on_admitted?: (admission: { run_id: string, status: string, replayed: boolean }) => void
  deps?: Partial<StartIssueReviewCommandDeps>
}

interface StartedIssueReview {
  run_id: string
}

export async function startIssueReviewCommand ({
  octokit,
  issue,
  event_type,
  review_objective = 'audit',
  repair_mode = null,
  delivery_id,
  on_admitted,
  deps = {}
}: StartIssueReviewCommandArgs): Promise<StartedIssueReview> {
  const {
    start_review = startIssueReviewRun,
    store = reviewRunStore,
    create_run_id = createRunId
  } = deps
  const candidate_run_id = create_run_id()
  const run = { workflow: 'issue-review' as const, run_id: candidate_run_id, publish_context: {} }
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

  let submitted: SubmittedIssueReviewRun
  try {
    submitted = await start_review({
      octokit, issue, run_id, event_type,
      review_objective: event_type === 'opened' ? 'audit' : review_objective,
      repair_mode: event_type === 'opened' ? null : repair_mode
    })
  } catch (error) {
    store.markFailed(run_id, {
      // Only transport-level uncertainty is recoverable. Preparation failures
      // are deterministic and must not be replayed as successful submissions.
      code: error instanceof RunnerSubmissionUncertainError ? 'SUBMISSION_STATE_UNCERTAIN' : 'REVIEW_START_FAILED',
      message: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
  try {
    store.mark_queued(run_id, issueReviewPublishContext(submitted))
  } catch (error) {
    store.markFailed(run_id, {
      code: 'SUBMISSION_STATE_UNCERTAIN',
      message: `Runner accepted the run, but its queued state was not recorded: ${error instanceof Error ? error.message : String(error)}`
    })
    throw error
  }

  return submitted
}
