import { clearImmediate, clearInterval } from 'node:timers'

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
