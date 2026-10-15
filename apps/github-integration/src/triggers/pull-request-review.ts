import { admitReviewRun } from '../control-plane/admission.js'
import {
  PreparationClaimLostError,
  startPreparationClaimHeartbeat
} from '../control-plane/preparation-claim.js'

import type { PullRequestContext } from '../github/pull-request-service.js'
import type { TrustedDefaultBranch } from '../github/default-branch-service.js'
import { pullRequestReviewPublishContext } from '../control-plane/publish-context.js'
import { controlPlaneClient } from '../control-plane/client.js'
import type { TestChangesPolicy } from '../runner/input.js'
import { isSetupDeclarationError } from '../github/setup-declaration.js'
import { ControlPlaneSubmissionError } from '../control-plane/client.js'
import {
  startPullRequestReviewRun,
  type SubmittedPullRequestReviewRun
} from '../reviews/pull-requests/submit.js'

type PullRequestReviewEventType = 'opened' | 'ready_for_review' | 'synchronize' | 'manual_review'
type StartPullRequestReview = typeof startPullRequestReviewRun
type PullRequestReviewControlPlaneClient = {
  admitReviewRun: (
    ...args: Parameters<typeof controlPlaneClient.admitReviewRun>
  ) =>
    | Awaited<ReturnType<typeof controlPlaneClient.admitReviewRun>>
    | ReturnType<typeof controlPlaneClient.admitReviewRun>
  failPreparation: (...args: Parameters<typeof controlPlaneClient.failPreparation>) => unknown
  submitPreparedRun: (...args: Parameters<typeof controlPlaneClient.submitPreparedRun>) => unknown
  renewPreparationClaim: (
    ...args: Parameters<typeof controlPlaneClient.renewPreparationClaim>
  ) => Promise<boolean>
  preparationHeartbeatIntervalMs: typeof controlPlaneClient.preparationHeartbeatIntervalMs
}

interface StartPullRequestReviewCommandDeps {
  start_review: StartPullRequestReview
  store: PullRequestReviewControlPlaneClient
}

interface StartPullRequestReviewCommandArgs {
  octokit: unknown
  pr?: PullRequestContext
  resolve_pr?: () => Promise<PullRequestContext>
  trusted_default_branch: TrustedDefaultBranch
  event_type: PullRequestReviewEventType
  // The PR path's only policy knob. The objective is fixed to `audit`, but an
  // audit review still reaches mitigation once a defect is confirmed, so the
  // patch-level test-changes constraint stays meaningful here.
  test_changes?: TestChangesPolicy | null
  delivery_id: string
  on_admitted?: (admission: { run_id: string; status: string; replayed: boolean }) => void
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
  on_admitted,
  deps = {}
}: StartPullRequestReviewCommandArgs): Promise<StartedPullRequestReview> {
  const { start_review = startPullRequestReviewRun, store = controlPlaneClient } = deps
  const admission = await admitReviewRun(store, {
    workflow: 'pull-request-review',
    ingress_kind: 'github_webhook',
    ingress_key: delivery_id
  })
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

  let submitted: SubmittedPullRequestReviewRun
  try {
    // Admission happens before PR lookup, input preparation, and Runner
    // submission. Any failure below therefore remains attached to this run_id
    // instead of becoming an untracked pre-run error.
    const resolvedPr = pr ?? (await resolve_pr?.())
    if (resolvedPr === undefined) {
      throw new Error('Pull request context is missing after admission.')
    }
    submitted = await start_review({
      octokit,
      pr: resolvedPr,
      trusted_default_branch,
      run_id,
      event_type,
      test_changes: event_type === 'manual_review' ? test_changes : null,
      on_prepared: async (prepared, input) => {
        // Confirm the lease immediately before crossing the durable submission
        // boundary; the submission itself remains token-fenced by Control Plane.
        await heartbeat.assertOwned()
        await store.submitPreparedRun(
          run_id,
          preparationToken,
          pullRequestReviewPublishContext(prepared),
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
        code: isSetupDeclarationError(error) ? 'SETUP_DECLARATION_INVALID' : 'REVIEW_START_FAILED',
        message: error instanceof Error ? error.message : String(error)
      })
    }
    throw error
  } finally {
    await heartbeat.stop()
  }

  return submitted
}
