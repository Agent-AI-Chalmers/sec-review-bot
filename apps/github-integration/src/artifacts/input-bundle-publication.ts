// The preparation owner registers the complete publication intent before crossing the object-store
// boundary. Recovery inspects that intent before any GitHub state is rebuilt.
import type { ReviewRunsClient } from '../review-runs/client.js'
import type { PublishContext } from '../review-runs/publish-context.js'
import type { InputBundleArtifactRef } from '../execution/input.js'
import { assertWorkflowInputFits } from '../reviews/shared/input-bundle.js'
import {
  inputBundleExists,
  publishedInputBundleReference,
  publishInputBundle
} from './input-storage.js'

export type InputBundlePublicationStore = Pick<
  ReviewRunsClient,
  | 'reserveInputBundleCandidate'
  | 'listInputBundleCandidates'
  | 'settleInputBundleCandidate'
> & {
  submitPreparedRun: (
    ...args: Parameters<ReviewRunsClient['submitPreparedRun']>
  ) => unknown
}

export async function publishAndSubmitInputBundle(
  store: InputBundlePublicationStore,
  runId: string,
  token: string,
  context: PublishContext,
  input: Record<string, unknown>
): Promise<void> {
  const local = input.input_bundle as InputBundleArtifactRef
  if (!local || typeof local.uri !== 'string')
    throw new Error('Prepared input is missing its input bundle.')
  const reference = publishedInputBundleReference(local, runId)
  const publishedInput = { ...input, input_bundle: reference }
  assertWorkflowInputFits(publishedInput, 'prepared review')
  await store.reserveInputBundleCandidate(runId, token, {
    reference,
    input: publishedInput,
    publish_context: context
  })
  await publishInputBundle(local, runId)
  await store.settleInputBundleCandidate(
    runId,
    token,
    reference.digest,
    'present'
  )
  await store.submitPreparedRun(runId, token, context, publishedInput)
}

/** Current preparation claim authorizes takeover; the reservation's original token does not. */
export async function recoverInputBundlePublication(
  store: InputBundlePublicationStore,
  runId: string,
  token: string
): Promise<boolean> {
  const candidates = await store.listInputBundleCandidates(runId, token)
  for (const candidate of candidates) {
    if (!(await inputBundleExists(candidate.reference))) {
      if (candidate.status === 'selected')
        throw new Error(
          'Selected input bundle is unavailable; cannot replace its input.'
        )
      // Abandonment cannot cancel an in-flight PUT. Do not delete the
      // object here: an old uploader may still finish, and publication intents can share it.
      await store.settleInputBundleCandidate(
        runId,
        token,
        candidate.digest,
        'abandoned'
      )
      continue
    }
    if (candidate.status !== 'selected')
      await store.settleInputBundleCandidate(
        runId,
        token,
        candidate.digest,
        'present'
      )
    // Publish context is checked against its workflow by the existing client boundary.
    await store.submitPreparedRun(
      runId,
      token,
      candidate.publish_context as PublishContext,
      candidate.input
    )
    return true
  }
  return false
}
