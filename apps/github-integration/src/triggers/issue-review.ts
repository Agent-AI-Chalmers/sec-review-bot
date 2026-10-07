import { admitReviewRun } from '../infrastructure/control-plane/admission.js'
import {
  PreparationClaimLostError,
  startPreparationClaimHeartbeat
} from '../infrastructure/control-plane/preparation-claim.js'

import type { IssueContext } from '../infrastructure/github/issue-service.js'
import { issueReviewPublishContext } from '../infrastructure/runner/publish-context.js'
import { startIssueReviewRun, type SubmittedIssueReviewRun } from '../reviews/issues/submit.js'
import type { RepairMode } from '../infrastructure/runner/input.js'
import { createRunId } from '../reviews/shared/input-bundle.js'
import { reviewRunStore } from '../infrastructure/runner/review-store.js'
import { ControlPlaneSubmissionError } from '../infrastructure/runner/review-store.js'

type IssueReviewEventType = 'opened' | 'manual_review'
type StartIssueReview = typeof startIssueReviewRun
type IssueReviewRunStore = {
  admit_review_run: (
    ...args: Parameters<typeof reviewRunStore.admit_review_run>
  ) =>
    | Awaited<ReturnType<typeof reviewRunStore.admit_review_run>>
    | ReturnType<typeof reviewRunStore.admit_review_run>
  failPreparation: (...args: Parameters<typeof reviewRunStore.failPreparation>) => unknown
  submit_prepared_run: (...args: Parameters<typeof reviewRunStore.submit_prepared_run>) => unknown
  renewPreparationClaim: (
    ...args: Parameters<typeof reviewRunStore.renewPreparationClaim>
  ) => Promise<boolean>
  preparationHeartbeatIntervalMs: typeof reviewRunStore.preparationHeartbeatIntervalMs
}
interface StartIssueReviewCommandDeps {
  start_review: StartIssueReview
  store: IssueReviewRunStore
  create_run_id: typeof createRunId
}

interface StartIssueReviewCommandArgs {
  octokit: unknown
  issue: IssueContext
  event_type: IssueReviewEventType
  review_objective?: 'audit' | 'repair' | null
  repair_mode?: RepairMode | null
  delivery_id: string
  on_admitted?: (admission: { run_id: string; status: string; replayed: boolean }) => void
  deps?: Partial<StartIssueReviewCommandDeps>
}

interface StartedIssueReview {
  run_id: string
}

export async function startIssueReviewCommand({
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
  const admission = await admitReviewRun(
    store,
    {
      workflow: 'issue-review',
      ingress_kind: 'github_webhook',
      ingress_key: delivery_id
    },
    create_run_id
  )
  on_admitted?.({
    run_id: admission.run_id,
    status: admission.status,
    replayed: !admission.created
  })
  if (!admission.created) {
    return { run_id: admission.run_id }
  }
  const run_id = admission.run_id
  const preparationToken = admission.preparation_token
  if (!preparationToken)
    throw new Error(`Newly admitted review run ${run_id} has no preparation claim.`)
  const heartbeat = await startPreparationClaimHeartbeat(store, run_id, preparationToken)

  let submitted: SubmittedIssueReviewRun
  try {
    submitted = await start_review({
      octokit,
      issue,
      run_id,
      event_type,
      review_objective: event_type === 'opened' ? 'audit' : review_objective,
      repair_mode: event_type === 'opened' ? null : repair_mode,
      on_prepared: async (prepared, input) => {
        // Confirm the lease immediately before crossing the durable submission
        // boundary; the submission itself remains token-fenced by Control Plane.
        await heartbeat.assertOwned()
        await store.submit_prepared_run(
          run_id,
          preparationToken,
          issueReviewPublishContext(prepared),
          input
        )
      }
    })
  } catch (error) {
    const ownsClaim = await heartbeat.stop()
    if (
      ownsClaim &&
      !(error instanceof ControlPlaneSubmissionError) &&
      !(error instanceof PreparationClaimLostError)
    ) {
      await store.failPreparation(run_id, preparationToken, {
        code: 'REVIEW_START_FAILED',
        message: error instanceof Error ? error.message : String(error)
      })
    }
    throw error
  } finally {
    await heartbeat.stop()
  }
  return submitted
}
