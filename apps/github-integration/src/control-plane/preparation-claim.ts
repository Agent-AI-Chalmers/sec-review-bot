import { clearInterval } from 'node:timers'

import { logWarn } from '../utils/logger.js'

interface PreparationClaimStore {
  renewPreparationClaim: (runId: string, token: string) => Promise<boolean>
  preparationHeartbeatIntervalMs: () => number | Promise<number>
}

export interface PreparationClaimHeartbeat {
  assertOwned: () => Promise<void>
  stop: () => Promise<boolean>
}

export class PreparationClaimLostError extends Error {
  constructor(runId: string) {
    super(`Preparation claim was lost for review run ${runId}.`)
    this.name = 'PreparationClaimLostError'
  }
}

/** Keeps long-running input preparation fenced to its current admission owner. */
export async function startPreparationClaimHeartbeat(
  store: PreparationClaimStore,
  runId: string,
  token: string
): Promise<PreparationClaimHeartbeat> {
  let stopped = false
  let lost = false
  let active: Promise<void> | null = null
  const intervalMs = await store.preparationHeartbeatIntervalMs()

  const renew = async (): Promise<void> => {
    try {
      if (!(await store.renewPreparationClaim(runId, token))) lost = true
    } catch (error) {
      // A transport failure does not prove that ownership was lost. Keep
      // retrying; the token-fenced submission remains the final authority.
      logWarn('review_preparation_heartbeat_failed', { error, run_id: runId })
      throw error
    }
  }
  const renewWithoutOverlap = async (): Promise<void> => {
    if (stopped) return
    // Timer and final ownership checks share one in-flight renewal so a slow
    // Control Plane response cannot create overlapping heartbeat requests.
    active ??= renew().finally(() => {
      active = null
    })
    await active
  }

  // Refresh once before returning control to potentially slow GitHub and
  // archive operations; do not wait for the first timer tick to prove ownership.
  await renewWithoutOverlap()
  if (lost) throw new PreparationClaimLostError(runId)

  const timer = setInterval(() => {
    void renewWithoutOverlap().catch(() => undefined)
  }, intervalMs)
  timer.unref?.()

  const stop = async (): Promise<boolean> => {
    if (!stopped) {
      stopped = true
      clearInterval(timer)
    }
    if (active !== null) await active.catch(() => undefined)
    return !lost
  }

  return {
    assertOwned: async () => {
      await renewWithoutOverlap()
      if (lost) throw new PreparationClaimLostError(runId)
    },
    stop
  }
}
