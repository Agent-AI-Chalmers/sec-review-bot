import { clearInterval } from 'node:timers'

import type { RunnerArtifactPublication } from '../runner/client.js'
import type { ReviewRunRecord, ReviewRunStore } from '../runner/review-store.js'

type TerminalCoordinationStore = Pick<ReviewRunStore,
  | 'markRunning'
  | 'recordArtifactPublication'
  | 'failRunnerExecution'
  | 'claimPublication'
  | 'renewPublicationClaim'
  | 'publicationHeartbeatIntervalMs'
  | 'completePublication'
  | 'failPublication'
  | 'getRun'>

export interface ObservedRunnerStatus {
  status: string
  artifact_publication?: RunnerArtifactPublication
}

interface ErrorInfo { code: string | null, message: string }
interface PublicationFailure extends ErrorInfo { retry: boolean, reason: string }

export type TerminalCoordinationResult =
  | { status: 'active' }
  | { status: 'poll_retry', error: unknown }
  | { status: 'runner_failed', source: 'poll' | 'execution', error: unknown, failure: ErrorInfo }
  | { status: 'publication_claim_unavailable' }
  | { status: 'publication_claim_lost', attempted_state: 'published' | 'pending' | 'failed' }
  | { status: 'published' }
  | { status: 'publication_failed', error: unknown, failure: PublicationFailure, status_after: string | null }

export interface TerminalCoordinationDependencies {
  getStatus: (runId: string) => Promise<ObservedRunnerStatus>
  describeError: (error: unknown) => ErrorInfo
  isTerminalPollingError: (error: unknown) => boolean
  runnerFailureFromStatus: (status: ObservedRunnerStatus, run: ReviewRunRecord) => unknown
  publish: (status: ObservedRunnerStatus, claimToken: string) => Promise<void>
  classifyPublicationFailure: (error: unknown) => PublicationFailure
  onHeartbeatError?: (error: unknown) => void
}

async function withPublicationHeartbeat (
  store: TerminalCoordinationStore,
  runId: string,
  claimToken: string,
  operation: () => Promise<void>,
  onHeartbeatError?: (error: unknown) => void
): Promise<boolean> {
  let claimLost = false
  let renewal: Promise<void> | null = null
  const renew = async (): Promise<void> => {
    try {
      if (!await store.renewPublicationClaim(runId, claimToken)) claimLost = true
    } catch (error) {
      onHeartbeatError?.(error)
    }
  }

  await renew()
  if (claimLost) return false
  const timer = setInterval(() => {
    if (renewal !== null) return
    renewal = renew().finally(() => { renewal = null })
  }, store.publicationHeartbeatIntervalMs())
  timer.unref?.()
  try {
    await operation()
    if (renewal !== null) await renewal
    await renew()
    return !claimLost
  } finally {
    clearInterval(timer)
    if (renewal !== null) await renewal
  }
}

/** Coordinates durable terminal state without interpreting workflow results. */
export async function coordinateTerminalRun (
  store: TerminalCoordinationStore,
  run: ReviewRunRecord,
  dependencies: TerminalCoordinationDependencies
): Promise<TerminalCoordinationResult> {
  let runnerStatus: ObservedRunnerStatus
  try {
    runnerStatus = await dependencies.getStatus(run.run_id)
  } catch (error) {
    if (!dependencies.isTerminalPollingError(error)) return { status: 'poll_retry', error }
    const failure = dependencies.describeError(error)
    await store.failRunnerExecution(run.run_id, {
      code: failure.code ?? 'RUNNER_STATUS_POLL_FAILED',
      message: failure.message
    })
    return { status: 'runner_failed', source: 'poll', error, failure }
  }

  if (runnerStatus.status !== 'succeeded' && runnerStatus.status !== 'failed') {
    if (runnerStatus.status === 'running' && run.status === 'queued') {
      await store.markRunning(run.run_id)
    }
    return { status: 'active' }
  }

  await store.recordArtifactPublication(run.run_id, runnerStatus.artifact_publication)
  if (runnerStatus.status === 'failed') {
    const error = dependencies.runnerFailureFromStatus(runnerStatus, run)
    const failure = dependencies.describeError(error)
    await store.failRunnerExecution(run.run_id, {
      code: failure.code ?? 'RUNNER_EXECUTION_FAILED',
      message: failure.message
    })
    return { status: 'runner_failed', source: 'execution', error, failure }
  }

  const claimToken = await store.claimPublication(run.run_id)
  if (claimToken === null) return { status: 'publication_claim_unavailable' }
  try {
    const ownsClaim = await withPublicationHeartbeat(
      store,
      run.run_id,
      claimToken,
      async () => await dependencies.publish(runnerStatus, claimToken),
      dependencies.onHeartbeatError
    )
    if (!ownsClaim) return { status: 'publication_claim_lost', attempted_state: 'published' }
    return await store.completePublication(run.run_id, claimToken)
      ? { status: 'published' }
      : { status: 'publication_claim_lost', attempted_state: 'published' }
  } catch (error) {
    const failure = dependencies.classifyPublicationFailure(error)
    const committed = await store.failPublication(
      run.run_id,
      claimToken,
      { code: failure.code, message: failure.message },
      { retry: failure.retry }
    )
    if (!committed) {
      return {
        status: 'publication_claim_lost',
        attempted_state: failure.retry ? 'pending' : 'failed'
      }
    }
    const updated = await store.getRun(run.run_id)
    return { status: 'publication_failed', error, failure, status_after: updated?.status ?? null }
  }
}
