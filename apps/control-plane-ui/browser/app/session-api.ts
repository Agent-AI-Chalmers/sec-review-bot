import { ApiError } from '../shared/api-client.js'

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
 * only - it does not revoke the access token. */
export async function logout(): Promise<void> {
  const response = await fetch('/api/session', { method: 'DELETE' })
  if (!response.ok) throw new ApiError(response.status)
}
