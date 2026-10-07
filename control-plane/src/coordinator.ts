import { clearImmediate, clearInterval } from 'node:timers'

import type { ReviewRunRecord, ReviewRunStore } from './review-store.js'

type CoordinationStore = Pick<ReviewRunStore,
  'expireStalePreparations' | 'listSubmissionRecoveries' | 'listActiveRuns'>

export interface ReviewRunCoordinationHandlers {
  recoverSubmission: (run: ReviewRunRecord) => Promise<void>
  observeActiveRun: (run: ReviewRunRecord) => Promise<void>
}

export async function coordinateReviewRunsOnce (
  store: CoordinationStore,
  handlers: ReviewRunCoordinationHandlers
): Promise<void> {
  await store.expireStalePreparations()

  for (const run of await store.listSubmissionRecoveries()) {
    await handlers.recoverSubmission(run)
  }

  for (const run of await store.listActiveRuns()) {
    await handlers.observeActiveRun(run)
  }
}

export interface ReviewRunCoordinatorLoop {
  stop: () => Promise<void>
}

/** Runs at most one coordination pass at a time and drains it during shutdown. */
export function startReviewRunCoordinatorLoop ({
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
      .finally(() => { active = null })
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
