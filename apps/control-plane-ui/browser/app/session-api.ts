import { request } from '../shared/api-client.js'

export async function login(token: string): Promise<void> {
  await request('/session', { method: 'POST', body: { token } })
}

/** Ends the browser session. The session cookie is HttpOnly, so the console cannot
 * clear it itself; the BFF expires it. This forgets the credential on this browser
 * only - it does not revoke the access token. */
export async function logout(): Promise<void> {
  await request('/session', { method: 'DELETE' })
}
