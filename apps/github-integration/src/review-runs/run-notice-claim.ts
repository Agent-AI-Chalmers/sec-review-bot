import { clearInterval } from 'node:timers'

import { logWarn } from '../utils/logger.js'

interface RunNoticeClaimStore {
  renewRunNoticeClaim: (noticeId: string, token: string) => Promise<boolean>
  runNoticeHeartbeatIntervalMs: () => number | Promise<number>
}

export interface RunNoticeClaimHeartbeat {
  assertOwned: () => Promise<void>
  stop: () => Promise<boolean>
}

export class RunNoticeClaimLostError extends Error {
  constructor(noticeId: string, options?: ErrorOptions) {
    super(`Run notice claim was lost for ${noticeId}.`, options)
    this.name = 'RunNoticeClaimLostError'
  }
}

/** Keep a notice fenced while GitHub reads and writes are in flight. */
export async function startRunNoticeClaimHeartbeat(
  store: RunNoticeClaimStore,
  noticeId: string,
  token: string
): Promise<RunNoticeClaimHeartbeat> {
  let stopped = false
  let lost = false
  let active: Promise<void> | null = null
  const intervalMs = await store.runNoticeHeartbeatIntervalMs()

  const renew = async (): Promise<void> => {
    try {
      if (!(await store.renewRunNoticeClaim(noticeId, token))) {
        throw new RunNoticeClaimLostError(noticeId)
      }
    } catch (error) {
      // An unconfirmed renewal is not permission to perform a public write. The notice remains
      // unfinished and becomes claimable again after the durable lease expires.
      lost = true
      logWarn('review_run_notice_heartbeat_failed', {
        error,
        notice_id: noticeId
      })
      throw error instanceof RunNoticeClaimLostError
        ? error
        : new RunNoticeClaimLostError(noticeId, { cause: error })
    }
  }
  const renewSerially = async (): Promise<void> => {
    if (lost) throw new RunNoticeClaimLostError(noticeId)
    active ??= renew().finally(() => {
      active = null
    })
    await active
    if (lost) throw new RunNoticeClaimLostError(noticeId)
  }

  await renewSerially()
  const timer = setInterval(() => {
    void renewSerially().catch(() => undefined)
  }, intervalMs)
  timer.unref?.()

  return {
    assertOwned: renewSerially,
    stop: async () => {
      if (!stopped) {
        stopped = true
        clearInterval(timer)
      }
      if (active !== null) await active.catch(() => undefined)
      return !lost
    }
  }
}
