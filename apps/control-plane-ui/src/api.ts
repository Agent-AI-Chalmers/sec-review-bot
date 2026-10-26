// The response shapes come from the generated contract projection rather than hand-written
// interfaces: `ArtifactStorage` is a discriminated union in the contract, and a flattened copy
// could not tell `available` (which requires `artifact`) apart from the other statuses.
import type {
  ArtifactStorage,
  ParkedRun,
  PublicationStep,
  Run,
  RunEvent
} from './review-runs-api-types.js'

export type { ArtifactStorage, ParkedRun, PublicationStep, Run, RunEvent }

/** Abandon a blocked run at an operator's explicit request.
 *
 * The admin token is supplied per call and only travels in this request header: the console keeps
 * it in component state for the duration of the dialog, and the BFF forwards it without storing
 * it. Nothing here can act on its own. */
export async function abandonBlockedRun(
  runId: string,
  reason: string,
  adminToken: string
): Promise<void> {
  const response = await fetch(
    `/api/admin/runs/${encodeURIComponent(runId)}/abandon`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-review-runs-admin-token': adminToken
      },
      body: JSON.stringify({ reason })
    }
  )
  if (!response.ok) {
    throw new ApiError(response.status, await errorCode(response))
  }
}

/** Hand a disconnected run back to automatic recovery at an operator's explicit request.
 *
 * The credential handling is identical to `abandonBlockedRun`: the admin token travels with this
 * one request and is never stored. The two decisions are deliberately separate calls — resuming
 * asks the system to try again, abandoning ends the run — so the console cannot send one while
 * meaning the other. */
export async function resumeDisconnectedRun(
  runId: string,
  adminToken: string
): Promise<void> {
  const response = await fetch(
    `/api/admin/runs/${encodeURIComponent(runId)}/resume`,
    {
      method: 'POST',
      headers: { 'x-review-runs-admin-token': adminToken }
    }
  )
  if (!response.ok) {
    throw new ApiError(response.status, await errorCode(response))
  }
}

/** Stop waiting for a disconnected run at an operator's explicit request.
 *
 * The third operator decision, and the one that does not claim anything was resolved: a
 * disconnected execution may still be running, and a disconnected publication may already have
 * delivered part of its result. It records that the outcome will not be waited for. */
export async function giveUpDisconnectedRun(
  runId: string,
  reason: string,
  adminToken: string
): Promise<void> {
  const response = await fetch(
    `/api/admin/runs/${encodeURIComponent(runId)}/give-up`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-review-runs-admin-token': adminToken
      },
      body: JSON.stringify({ reason })
    }
  )
  if (!response.ok) {
    throw new ApiError(response.status, await errorCode(response))
  }
}

/** The runs coordination has stopped retrying. Reading this needs only the read token: knowing
 * a run is stuck is not privileged, only deciding what to do about it is. */
export async function parkedRuns(): Promise<ParkedRun[]> {
  const body = await api<{ blocks: ParkedRun[] }>('/runs/parked')
  return body.blocks
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** The BFF's own error code, when it sent one, so the console can say what failed. */
    readonly code?: string
  ) {
    super(`Request failed (${status})`)
  }
}

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json()
    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'string'
    ) {
      return body.error
    }
  } catch {
    // Not every failure carries a body; the status still identifies it.
  }
  return undefined
}

export async function api<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`)
  if (!response.ok)
    throw new ApiError(response.status, await errorCode(response))
  return (await response.json()) as T
}
export async function login(token: string): Promise<void> {
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token })
  })
  if (!response.ok) throw new ApiError(response.status)
}
/** Ends the browser session. The session cookie is HttpOnly, so the console cannot
 * clear it itself; the BFF expires it. This forgets the credential on this browser
 * only — it does not revoke the access token. */
export async function logout(): Promise<void> {
  const response = await fetch('/api/session', { method: 'DELETE' })
  if (!response.ok) throw new ApiError(response.status)
}
