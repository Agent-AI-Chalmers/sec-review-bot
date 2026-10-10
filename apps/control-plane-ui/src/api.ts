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
export interface Run {
  run_id: string
  workflow: string
  execution_status: 'preparing' | 'recovering' | 'queued' | 'running' | 'succeeded' | 'failed'
  publication_status: 'pending' | 'publishing' | 'published' | 'failed' | 'skipped'
  created_at: string
  execution_updated_at: string
  publication_updated_at: string
  published_at: string | null
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
  if (!response.ok) throw new ApiError(response.status, await errorCode(response))
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
