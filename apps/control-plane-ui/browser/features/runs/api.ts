import { api, request } from '../../shared/api-client.js'
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

/** The operator decisions Review Runs accepts for a parked run. */
export type AdminRunAction = 'abandon' | 'resume' | 'give-up'

/**
 * Take one operator decision on a parked run.
 *
 * The credential is supplied by the operator for this request and forwarded as-is; the BFF
 * keeps no copy. A reason is carried only for the decisions that record one, so a resume does
 * not pretend to explain itself.
 */
export async function adminRunAction(
  runId: string,
  action: AdminRunAction,
  { adminToken, reason }: { adminToken: string; reason?: string }
): Promise<void> {
  await request(`/admin/runs/${encodeURIComponent(runId)}/${action}`, {
    method: 'POST',
    headers: { 'x-review-runs-admin-token': adminToken },
    ...(reason === undefined ? {} : { body: { reason } })
  })
}

/** Read runs whose automatic coordination has stopped retrying. */
export async function parkedRuns(): Promise<ParkedRun[]> {
  const body = await api<{ blocks: ParkedRun[] }>('/runs/parked')
  return body.blocks
}
