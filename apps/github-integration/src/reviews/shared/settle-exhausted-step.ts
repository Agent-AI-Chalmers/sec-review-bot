// Concluding a publication step that ran out of attempts, from what is actually on GitHub.
//
// A step reaches `retry_exhausted` when there is no attempt left to give it. Control Plane cannot
// read GitHub, so it deliberately does not decide what that means: a `running` step belongs to a
// publisher that started the side effect and may have finished it before dying, and a `failed`
// step's last attempt may also have taken effect before its response was lost. Concluding either
// as a failure without looking would report a published review as unpublished.
//
// So the connector looks. Each step knows what its own side effect looks like remotely — a
// run-specific branch, a review marker, a comment marker — and that check is the only thing that
// may end an exhausted step. `settleExhaustedPublicationStep` writes the answer back, turning the
// step into `succeeded` when the effect exists and `terminal_failed` only once it was confirmed
// absent.
import type { Octokit } from 'octokit'

import type { PublicationStepStore } from '../../control-plane/client.js'
import { RUNNER_PUBLISH_ERROR_CODES } from '../../runner/publish-error-code.js'
import { errorCode } from '../../utils/error-utils.js'

/** Whether a publish error is the "no attempts left, reconcile first" signal. */
export function isPublicationStepExhausted(error: unknown): boolean {
  return (
    errorCode(error) ===
    RUNNER_PUBLISH_ERROR_CODES.publication_step_retry_exhausted
  )
}

/** What a reconciliation found, in the shape the completion path already uses. */
export type ReconciledRemote = { id?: string | number | null; url?: string }

/**
 * Reconcile an exhausted step, then either continue as if it had succeeded or report the failure.
 *
 * `find` must answer exactly one question: does this step's side effect already exist on the
 * remote system? It answers `null` when it looked and found nothing, which is the only outcome
 * that makes the step a terminal failure. An error from `find` propagates: a reconciliation that
 * could not be performed is not evidence of absence, and treating it as such is the bug this
 * module exists to avoid.
 *
 * Every outcome after `find` returns says what Control Plane now stores, not merely what the
 * remote system looked like. That is the point of the names: a caller never has to know which
 * branch wrote to the step to tell whether it did. The recorded states are the same words the
 * schema uses (`succeeded`, `terminal_failed`), so reading a call site does not require a
 * translation table.
 *
 * - `recorded` with `step: 'succeeded'`: the effect was found and the write was accepted, so the
 *   step is `succeeded`. The caller may carry on as if it had completed the step itself.
 * - `recorded` with `step: 'terminal_failed'`: the effect was absent and the write was accepted,
 *   so the step is now `terminal_failed`. That conclusion is already on the record, and the
 *   caller reports it as the failure it is.
 * - `not_owned`: the write was refused because another owner moved the step or the publication
 *   while this reconciliation ran. Nothing was recorded, and the step is whatever that other
 *   owner made it — so the caller must neither carry on nor record a result of its own; it
 *   propagates the original exhaustion error instead.
 */
export type SettleExhaustedOutcome =
  | { outcome: 'recorded'; step: 'succeeded'; remote: ReconciledRemote }
  | { outcome: 'recorded'; step: 'terminal_failed' }
  | { outcome: 'not_owned' }

export async function settleExhaustedStep({
  store,
  runId,
  token,
  stepKey,
  find
}: {
  store: PublicationStepStore
  runId: string
  token: string
  stepKey: string
  find: () => Promise<ReconciledRemote | null>
}): Promise<SettleExhaustedOutcome> {
  const found = await find()
  const settled = await store.settleExhaustedPublicationStep(
    runId,
    token,
    stepKey,
    found === null ? null : { remote: found }
  )
  // Nothing was written. The publication coordinator turns the error these callers then
  // propagate (`PUBLICATION_STEP_RETRY_EXHAUSTED`) into a terminal failure on the publication,
  // which releases the claim so the next owner re-reads the step instead of this lease waiting
  // to expire. That record is about the publication, not about this step's remote effect.
  if (!settled) return { outcome: 'not_owned' }
  // Both remaining branches wrote to the step; only the recorded state and the remote reference
  // differ between them.
  return found === null
    ? { outcome: 'recorded', step: 'terminal_failed' }
    : { outcome: 'recorded', step: 'succeeded', remote: found }
}

/** The open pull request whose head is this run's draft branch, if one was already created.
 *
 * A draft PR is created from a branch whose name embeds the run id, so an open PR from that head
 * is unambiguously this step's side effect. A closed or merged one is not: it is not something
 * this run can still complete, and reusing it would attach the publication to unrelated work. */
export async function findOpenPullRequestByHeadBranch(
  octokit: Octokit,
  {
    owner_login,
    repo_name,
    branch_name
  }: { owner_login: string; repo_name: string; branch_name: string }
): Promise<{ number: number; html_url: string } | null> {
  const response = await octokit.rest.pulls.list({
    owner: owner_login,
    repo: repo_name,
    head: `${owner_login}:${branch_name}`,
    state: 'open',
    per_page: 1
  })
  const pull = response.data[0]
  return pull === undefined
    ? null
    : { number: pull.number, html_url: pull.html_url }
}
