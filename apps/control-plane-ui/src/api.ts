export interface ArtifactPublication {
  status: 'published' | 'not_available' | 'failed'
  artifact?: {
    kind: 'diagnostic_bundle'
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
  status: string
  created_at: string
  updated_at: string
  published_at: string | null
  failure_code: string | null
  artifact_publication: ArtifactPublication | null
}
export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`Request failed (${status})`)
  }
}
export async function api<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`)
  if (!response.ok) throw new ApiError(response.status)
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
