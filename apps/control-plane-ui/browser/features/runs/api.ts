import { ApiError, api, errorCode } from '../../shared/api-client.js'
import type {
  ArtifactStorage,
  ParkedRun,
  PublicationStep,
  Run,
  RunEvent
} from './api-types.generated.js'

export type { ArtifactStorage, ParkedRun, PublicationStep, Run, RunEvent }
export {
  ApiError,
  api,
  isAbortError,
  isUnauthorizedApiError,
  throwIfUnauthorized
} from '../../shared/api-client.js'

/** Abandon a blocked run at an operator's explicit request. */
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
  if (!response.ok)
    throw new ApiError(response.status, await errorCode(response))
}

/** Hand a disconnected run back to automatic recovery at an operator's request. */
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
  if (!response.ok)
    throw new ApiError(response.status, await errorCode(response))
}

/** Stop waiting for a disconnected run at an operator's explicit request. */
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
  if (!response.ok)
    throw new ApiError(response.status, await errorCode(response))
}

/** Read runs whose automatic coordination has stopped retrying. */
export async function parkedRuns(): Promise<ParkedRun[]> {
  const body = await api<{ blocks: ParkedRun[] }>('/runs/parked')
  return body.blocks
}
