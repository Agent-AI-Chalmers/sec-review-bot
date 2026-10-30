// Driving one publication step to a recorded outcome.
//
// Every publisher has to answer the same questions in the same order: has this step already
// succeeded, may this attempt claim it, what does an exhausted claim mean when the side effect may
// already exist remotely, and who records the result. Those questions are the protocol, not the
// publisher: what varies is only *how* to look for the effect and *what* the effect is.
//
// Keeping the order in one place is what stops it drifting. The copies in the issue, pull request
// and repository publishers had already diverged — a positional lookup in one, a keyed lookup in
// another, and three different predicates for "already done".
import type { PublicationStepStore } from '../../review-runs/client.js'
import { classifyPublicationFailure } from '../../review-runs/publication-failure.js'
import {
  isPublicationClaimLostError,
  PublicationClaimLostError
} from '../../review-runs/publication-claim.js'
import { asErrorMessage } from '../../utils/error-utils.js'
import {
  isPublicationStepExhausted,
  settleExhaustedStep,
  type ReconciledRemote
} from './settle-exhausted-step.js'

/** What one call did, so the caller can log it without re-reading the step. */
export interface PublicationStepRun {
  /** The remote object this step published, when it published one. */
  remote: ReconciledRemote
  /**
   * True when no new side effect was needed: the step was already `succeeded`, or
   * reconciliation found its remote effect. Reconciliation records that effect; the
   * already-succeeded shortcut does not write.
   */
  alreadySucceeded: boolean
  /** True when the success came from reconciling an exhausted claim against the remote system. */
  reconciled: boolean
  /** Attempts the step had recorded before this call; more than one means a retry. */
  previousAttempts: number
}

function recordedRemote(step: {
  remote_object_id: string | null
  remote_object_url: string | null
}): ReconciledRemote {
  return {
    id: step.remote_object_id,
    ...(step.remote_object_url === null ? {} : { url: step.remote_object_url })
  }
}

/**
 * Run one publication step: short-circuit, claim, effect, complete, or record the failure.
 *
 * `find` answers exactly one question — does this step's side effect already exist? It is only
 * called after an exhausted claim, when no attempt remains to run the workflow's idempotent
 * effect path. Earlier retries can also recover an existing effect through that path. An error
 * from `find` propagates: a reconciliation that could not be performed is not evidence of absence.
 *
 * `effect` performs the side effect and returns what the remote system now holds. `assertClaim` is
 * asked again immediately before it: a lease is permission to start a side effect, not merely
 * permission to record one afterwards.
 *
 * A failure while performing or completing is classified and recorded on the step, then rethrown.
 * A lost claim is rethrown untouched, because another owner is now responsible for the step and a
 * failure record from this one would be a lie about who acted.
 */
export async function runPublicationStep({
  store,
  runId,
  token,
  stepKey,
  assertClaim,
  find,
  effect
}: {
  store: PublicationStepStore
  runId: string
  token: string
  stepKey: string
  assertClaim: () => Promise<void>
  find: () => Promise<ReconciledRemote | null>
  effect: () => Promise<ReconciledRemote | null>
}): Promise<PublicationStepRun> {
  const step = (await store.listPublicationSteps(runId)).find(
    (item) => item.step_key === stepKey
  )
  const previousAttempts = step?.attempt_count ?? 0
  if (step?.status === 'succeeded')
    return {
      remote: recordedRemote(step),
      alreadySucceeded: true,
      reconciled: false,
      previousAttempts
    }

  try {
    await store.requirePublicationStepClaim(runId, token, stepKey)
  } catch (error) {
    if (!isPublicationStepExhausted(error)) throw error
    // No attempts left. The publisher that started this step may already have performed it, so
    // concluding it as failed without looking would report a published effect as missing.
    const settled = await settleExhaustedStep({
      store,
      runId,
      token,
      stepKey,
      find
    })
    if (settled.outcome !== 'recorded' || settled.step !== 'succeeded')
      throw error
    return {
      remote: settled.remote,
      alreadySucceeded: true,
      reconciled: true,
      previousAttempts
    }
  }

  try {
    await assertClaim()
    const remote = (await effect()) ?? {}
    if (!(await store.completePublicationStep(runId, token, stepKey, remote)))
      throw new PublicationClaimLostError(runId)
    return {
      remote,
      alreadySucceeded: false,
      reconciled: false,
      previousAttempts
    }
  } catch (error) {
    if (isPublicationClaimLostError(error)) throw error
    const failure = classifyPublicationFailure(error)
    await store.failPublicationStep(
      runId,
      token,
      stepKey,
      { code: failure.code, message: asErrorMessage(error) },
      { retry: failure.retry }
    )
    throw error
  }
}
