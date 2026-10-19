export interface ArtifactStorage {
  status: 'available' | 'unavailable' | 'failed'
  artifact?: {
    kind: 'diagnostic_bundle'
    /** Where the Runner stored the bundle. The contract requires it. */
    uri: string
    media_type: string
    digest: string
    size_bytes: number
  }
  error_code?: string
  message?: string
}
export interface RunEvent {
  event_id: number
  axis: 'runner' | 'preparation' | 'publication' | 'notice'
  from_status: string | null
  to_status: string
  reason_code: string | null
  occurred_at: string
}

export interface Run {
  run_id: string
  workflow: 'issue-review' | 'pull-request-review' | 'repository-review'
  preparation: {
    status: 'pending' | 'preparing' | 'submitted' | 'failed'
    attempt_count: number
    started_at: string | null
    finished_at: string | null
    updated_at: string
    failure_code: string | null
    failure_notice_status:
      'pending' | 'delivering' | 'delivered' | 'skipped' | null
  }
  // The three axes share one shape: where each phase started, where it ended, and — for
  // execution only — when it was last observed. A `skipped` phase has an end and no start.
  execution: {
    status:
      | 'pending'
      | 'queued'
      | 'running'
      | 'uncertain'
      | 'succeeded'
      | 'skipped'
      | 'failed'
    started_at: string | null
    finished_at: string | null
    updated_at: string
  }
  publication: {
    status: 'pending' | 'publishing' | 'published' | 'failed' | 'skipped'
    started_at: string | null
    finished_at: string | null
    updated_at: string
  }
  created_at: string
  failure_code: string | null
  artifact_storage: ArtifactStorage | null
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
