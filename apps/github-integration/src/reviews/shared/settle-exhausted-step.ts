// Concluding a publication step that ran out of attempts, from what is actually on GitHub.
//
// A step reaches `retry_exhausted` when there is no attempt left to give it. Review Runs cannot
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

import type { PublicationStepStore } from '../../review-runs/client.js'
import { EXECUTION_PUBLISH_ERROR_CODES } from '../../execution/publish-error-code.js'
import { classifyPublicationFailure } from '../../review-runs/publication-failure.js'
import { asErrorMessage, errorCode } from '../../utils/error-utils.js'

/** Whether a publish error is the "no attempts left, reconcile first" signal. */
export function isPublicationStepExhausted(error: unknown): boolean {
  return (
    errorCode(error) ===
    EXECUTION_PUBLISH_ERROR_CODES.publication_step_retry_exhausted
  )
}

const RECORDED = Symbol('reconciliation failure recorded on its step')
const RECOVERY_ATTEMPT = Symbol('recovery attempt count the lookup failed at')

/** Whether this error is a reconciliation lookup failure already recorded on its step. A caller
 * that records step failures itself must not record it a second time. The original error is
 * thrown unchanged, so its status still drives retry classification. */
export function isRecordedReconciliationFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && RECORDED in error
}

/** The step's `recovery_attempt_count` before the failed lookup this error reports, when the
 * lookup failed but recording it did not complete. A caller that records the failure itself
 * passes it as `expectedRecoveryAttemptCount`, so if the earlier write did commit, Review Runs
 * recognizes the same failure and does not spend the budget twice. */
export function unrecordedRecoveryAttemptCount(
  error: unknown
): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const value = (error as { [RECOVERY_ATTEMPT]?: unknown })[RECOVERY_ATTEMPT]
  return typeof value === 'number' ? value : undefined
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
 * Every outcome after `find` returns says what Review Runs now stores, not merely what the
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
  // The count this lookup will be reported against, read before looking. Like an activity
  // failure that carries its attempt number, it identifies this one failure, so reporting it
  // again after a lost response cannot spend the budget a second time.
  const expectedRecoveryAttemptCount = (
    await store.listPublicationSteps(runId)
  ).find((step) => step.step_key === stepKey)?.recovery_attempt_count
  let found: ReconciledRemote | null
  try {
    found = await find()
  } catch (error) {
    // A failed lookup settles nothing: it is not evidence of absence. It is recorded as a failed
    // reconciliation of this `uncertain` step, retryable when transient, because that is what
    // spends the step's reconciliation budget: a remote that keeps failing then parks the step
    // as `disconnected` for an operator instead of being looked at again forever.
    const failure = classifyPublicationFailure(error)
    // Throw an object so a marker always sticks; a thrown primitive would otherwise lose it.
    const thrown =
      typeof error === 'object' && error !== null
        ? error
        : new Error(asErrorMessage(error), { cause: error })
    if (expectedRecoveryAttemptCount !== undefined)
      Object.defineProperty(thrown, RECOVERY_ATTEMPT, {
        value: expectedRecoveryAttemptCount
      })
    // A lost response leaves it unknown whether the write committed. Reporting against the same
    // count makes a repeat harmless, so it is retried once here, where every caller passes
    // through, instead of in each caller.
    const record = async () =>
      await store.failPublicationStep(
        runId,
        token,
        stepKey,
        { code: failure.code, message: asErrorMessage(error) },
        {
          retry: failure.retry,
          ...(expectedRecoveryAttemptCount === undefined
            ? {}
            : { expectedRecoveryAttemptCount })
        }
      )
    try {
      await record().catch(record)
    } catch {
      // Still unknown. The lookup error is the diagnosis, so it is what propagates, unmarked: a
      // caller that records step failures records it with the same count, which Review Runs
      // applies at most once; one that does not leaves it to the next pass, which looks again.
      throw thrown
    }
    Object.defineProperty(thrown, RECORDED, { value: true })
    throw thrown
  }
  const settled = await store.settleExhaustedPublicationStep(
    runId,
    token,
    stepKey,
    found === null ? null : { remote: found }
  )
  // Nothing was written: another owner moved the step or the publication, so this caller no
  // longer owns it. The caller rethrows the exhaustion error and records nothing of its own; the
  // claim's lease decides who acts next.
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
