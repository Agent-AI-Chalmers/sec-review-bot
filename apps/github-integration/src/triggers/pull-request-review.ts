import { admitReviewRun } from '../infrastructure/control-plane/admission.js'

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
type PullRequestReviewRunStore = {
  admit_review_run: (...args: Parameters<typeof reviewRunStore.admit_review_run>) => Awaited<ReturnType<typeof reviewRunStore.admit_review_run>> | ReturnType<typeof reviewRunStore.admit_review_run>
  mark_queued: (...args: Parameters<typeof reviewRunStore.mark_queued>) => unknown
  failPreparation: (...args: Parameters<typeof reviewRunStore.failPreparation>) => unknown
  save_prepared_submission?: (...args: Parameters<typeof reviewRunStore.save_prepared_submission>) => unknown
}

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
  const admission = await admitReviewRun(store, {
    workflow: 'pull-request-review',
    ingress_kind: 'github_webhook',
    ingress_key: delivery_id
  }, create_run_id)
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
  if (!preparationToken) throw new Error(`Newly admitted review run ${run_id} has no preparation claim.`)

  let submitted: SubmittedPullRequestReviewRun
  try {
    // Admission happens before PR lookup, input preparation, and Runner
    // submission. Any failure below therefore remains attached to this run_id
    // instead of becoming an untracked pre-run error.
    const resolvedPr = pr ?? await resolve_pr?.()
    if (resolvedPr === undefined) {
      throw new Error('Pull request context is missing after admission.')
    }
    submitted = await start_review({
      octokit,
      pr: resolvedPr,
      run_id,
      event_type,
      repair_mode: event_type === 'manual_review' ? repair_mode : null,
      on_prepared: async (prepared, input) => {
        await store.save_prepared_submission?.(
          run_id, preparationToken,
          pullRequestReviewPublishContext(prepared),
          input
        )
      }
    })
  } catch (error) {
    await store.failPreparation(run_id, preparationToken, {
      // A lost Runner response is recoverable by replaying the same run_id;
      // PR context and input preparation failures remain terminal.
      code: error instanceof RunnerSubmissionUncertainError ? 'SUBMISSION_STATE_UNCERTAIN' : 'REVIEW_START_FAILED',
      message: error instanceof Error ? error.message : String(error)
    })
    throw error
  }

  try {
    await store.mark_queued(run_id, preparationToken, pullRequestReviewPublishContext(submitted))
  } catch (error) {
    await store.failPreparation(run_id, preparationToken, {
      code: 'SUBMISSION_STATE_UNCERTAIN',
      message: `Runner accepted the run, but its queued state was not recorded: ${error instanceof Error ? error.message : String(error)}`
    })
    throw error
  }

  return submitted
}
