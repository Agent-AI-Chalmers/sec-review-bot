// Turns an issue review request into a durable run, fencing preparation until
// the Execution submission boundary has been crossed.
import { admitReviewRun } from '../control-plane/admission.js'
import {
  PreparationClaimLostError,
  startPreparationClaimHeartbeat
} from '../control-plane/preparation-claim.js'

import type { IssueContext } from '../github/issue-service.js'
import { issueReviewPublishContext } from '../control-plane/publish-context.js'
import {
  startIssueReviewRun,
  type SubmittedIssueReviewRun
} from '../reviews/issues/submit.js'
import type { TrustedDefaultBranch } from '../github/default-branch-service.js'
import type { TestChangesPolicy } from '../execution/input.js'
import { controlPlaneClient } from '../control-plane/client.js'
import { isSetupDeclarationError } from '../github/setup-declaration.js'
import { ControlPlaneSubmissionError } from '../control-plane/client.js'
import { classifyPreparationFailure } from '../control-plane/preparation-failure.js'
import type { Octokit } from 'octokit'

type IssueReviewEventType = 'opened' | 'manual_review'
type StartIssueReview = typeof startIssueReviewRun
type IssueReviewControlPlaneClient = {
  admitReviewRun: (
    ...args: Parameters<typeof controlPlaneClient.admitReviewRun>
  ) =>
    | Awaited<ReturnType<typeof controlPlaneClient.admitReviewRun>>
    | ReturnType<typeof controlPlaneClient.admitReviewRun>
  failPreparation: (
    ...args: Parameters<typeof controlPlaneClient.failPreparation>
  ) => unknown
  submitPreparedRun: (
    ...args: Parameters<typeof controlPlaneClient.submitPreparedRun>
  ) => unknown
  renewPreparationClaim: (
    ...args: Parameters<typeof controlPlaneClient.renewPreparationClaim>
  ) => Promise<boolean>
  preparationHeartbeatIntervalMs: typeof controlPlaneClient.preparationHeartbeatIntervalMs
}
interface StartIssueReviewCommandDeps {
  start_review: StartIssueReview
  store: IssueReviewControlPlaneClient
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
  claimed_preparation?: {
    run_id: string
    token: string
    attempt_count?: number
  }
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
  const { start_review = startIssueReviewRun, store = controlPlaneClient } =
    deps
  const admission =
    claimed_preparation === undefined
      ? await admitReviewRun(store, {
          workflow: 'issue-review',
          ingress_kind: 'github_webhook',
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
        })
      : null
  if (admission !== null) {
    on_admitted?.({
      run_id: admission.run_id,
      status: admission.status,
      replayed: !admission.created
    })
    if (!admission.created) return { run_id: admission.run_id }
  }
  const run_id = claimed_preparation?.run_id ?? admission?.run_id
  const preparationToken =
    claimed_preparation?.token ?? admission?.preparation_token
  const preparationAttempt = claimed_preparation?.attempt_count ?? 1
  if (run_id === undefined)
    throw new Error('Preparation admission did not return a run id.')
  if (!preparationToken)
    throw new Error(
      `Newly admitted review run ${run_id} has no preparation claim.`
    )
  const heartbeat = await startPreparationClaimHeartbeat(
    store,
    run_id,
    preparationToken
  )

  let submitted: SubmittedIssueReviewRun
  try {
    submitted = await start_review({
      octokit,
      issue,
      trusted_default_branch,
      run_id,
      event_type,
      review_objective: event_type === 'opened' ? 'audit' : review_objective,
      test_changes: event_type === 'opened' ? null : test_changes,
      // Automatic triggers have no per-run comment to opt in, so they never open a PR.
      open_pr: event_type === 'opened' ? false : open_pr,
      on_prepared: async (prepared, input) => {
        // Confirm the lease immediately before crossing the durable submission
        // boundary; the submission itself remains token-fenced by Control Plane.
        await heartbeat.assertOwned()
        await store.submitPreparedRun(
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
      const classification = classifyPreparationFailure(
        error,
        preparationAttempt,
        isSetupDeclarationError(error)
      )
      await store.failPreparation(
        run_id,
        preparationToken,
        {
          code: isSetupDeclarationError(error)
            ? 'SETUP_DECLARATION_INVALID'
            : 'REVIEW_START_FAILED',
          message: error instanceof Error ? error.message : String(error)
        },
        {
          retry: classification.retry,
          ...(classification.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: classification.retryAfterMs })
        }
      )
    }
    throw error
  } finally {
    await heartbeat.stop()
  }
  return submitted
}
