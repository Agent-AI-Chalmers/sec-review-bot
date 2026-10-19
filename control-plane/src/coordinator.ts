import { clearImmediate, clearInterval } from 'node:timers'

import type {
  DroppedRunRow,
  PreparationExpiryBlocked,
  ReviewRunRecord,
  ReviewRunStore
} from './review-store.js'
import type { RunnerRunStatusBatch } from './runner-client.js'

type CoordinationStore = Pick<
  ReviewRunStore,
  'expireStalePreparations' | 'listSubmissionRecoveries' | 'listActiveRuns'
>

export interface ReviewRunCoordinationHandlers {
  recoverSubmission: (run: ReviewRunRecord) => Promise<void>
  /** Read the whole pass's runner statuses in one request. */
  readRunnerStatuses: (
    runs: readonly ReviewRunRecord[]
  ) => Promise<RunnerRunStatusBatch>
  observeActiveRun: (
    run: ReviewRunRecord,
    statuses: RunnerRunStatusBatch
  ) => Promise<void>
  /** Report a stored row the contract cannot represent. The pass continues without it, so a
   * single corrupt row degrades one run's coordination instead of stopping the whole pass. */
  onDroppedRunRow: (dropped: DroppedRunRow) => void
  /** Report a run whose expired preparation could not be concluded. Coordination cannot repair
   * it and deliberately does not retry it, so this is the operator's signal to intervene. Like a
   * dropped row it must not abort the pass: the other runs still need coordinating. */
  onBlockedPreparationExpiry: (blocked: PreparationExpiryBlocked) => void
}

export async function coordinateReviewRunsOnce(
  store: CoordinationStore,
  handlers: ReviewRunCoordinationHandlers
): Promise<void> {
  // Expiry isolates each row, so a run whose story contradicts itself no longer aborts the pass
  // before recovery and observation get to run. It is reported and skipped instead.
  const expiry = await store.expireStalePreparations()
  for (const blocked of expiry.blocked) {
    handlers.onBlockedPreparationExpiry(blocked)
  }

  // Both reads are fan-outs: a stored row the contract cannot represent would otherwise
  // abort the read (and so the whole pass) for every run. Report the bad row and carry on.
  const recoveries = await store.listSubmissionRecoveries()
  for (const dropped of recoveries.dropped) {
    handlers.onDroppedRunRow(dropped)
  }
  for (const run of recoveries.runs) {
    await handlers.recoverSubmission(run)
  }

  const { runs: active, dropped } = await store.listActiveRuns()
  for (const droppedRow of dropped) {
    handlers.onDroppedRunRow(droppedRow)
  }
  if (active.length === 0) return
  // One request for the whole pass rather than one per run. The per-run shape made the
  // number of requests grow with the number of runs in flight, so the busiest moments
  // were the ones that checked least often.
  const statuses = await handlers.readRunnerStatuses(active)
  for (const run of active) {
    await handlers.observeActiveRun(run, statuses)
  }
}

export interface ReviewRunCoordinatorLoop {
  stop: () => Promise<void>
}

/** Runs at most one coordination pass at a time and drains it during shutdown. */
export function startReviewRunCoordinatorLoop({
  intervalMs,
  runOnce,
  onError
}: {
  intervalMs: number
  runOnce: () => Promise<void>
  onError: (error: unknown) => void
}): ReviewRunCoordinatorLoop {
  let stopped = false
  let active: Promise<void> | null = null
  const tick = (): void => {
    if (stopped || active !== null) return
    active = runOnce()
      .catch(onError)
      .finally(() => {
        active = null
      })
  }

  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  const initialTick = setImmediate(tick)
  return {
    stop: async () => {
      stopped = true
      clearImmediate(initialTick)
      clearInterval(timer)
      await active
    }
  }
}
