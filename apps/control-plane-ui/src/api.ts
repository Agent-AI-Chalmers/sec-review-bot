// The response shapes come from the generated contract projection rather than hand-written
// interfaces: `ArtifactStorage` is a discriminated union in the contract, and a flattened copy
// could not tell `available` (which requires `artifact`) apart from the other statuses.
import type {
  ArtifactStorage,
  PublicationStep,
  Run,
  RunEvent
} from './control-plane-api-types.js'

export type { ArtifactStorage, PublicationStep, Run, RunEvent }

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
