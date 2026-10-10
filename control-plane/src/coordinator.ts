import { clearImmediate, clearInterval } from 'node:timers'

import type { ReviewRunRecord, ReviewRunStore } from './review-store.js'
import type { RunnerRunStatusBatch } from './runner-client.js'

type CoordinationStore = Pick<
  ReviewRunStore,
  'expireStalePreparations' | 'listSubmissionRecoveries' | 'listActiveRuns'
>

export interface ReviewRunCoordinationHandlers {
  recoverSubmission: (run: ReviewRunRecord) => Promise<void>
  /** Read the whole pass's runner statuses in one request. */
  readRunnerStatuses: (runs: readonly ReviewRunRecord[]) => Promise<RunnerRunStatusBatch>
  observeActiveRun: (run: ReviewRunRecord, statuses: RunnerRunStatusBatch) => Promise<void>
}

export async function coordinateReviewRunsOnce(
  store: CoordinationStore,
  handlers: ReviewRunCoordinationHandlers
): Promise<void> {
  await store.expireStalePreparations()

  for (const run of await store.listSubmissionRecoveries()) {
    await handlers.recoverSubmission(run)
  }

  const active = await store.listActiveRuns()
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
