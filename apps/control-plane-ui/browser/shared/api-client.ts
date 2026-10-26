export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** The BFF's own error code, when it sent one, so the console can say what failed. */
    readonly code?: string
  ) {
    super(`Request failed (${status})`)
  }
}

/** Session failures must be rendered by the app-level ErrorBoundary, not translated into a
 * resource-specific loading error. Keep the check here so every query surface uses the same
 * definition of an expired or missing UI session. */
export function isUnauthorizedApiError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 401
}

/** Fetch rejects cancellation with a DOMException, but the exception may originate in another
 * browser realm where `instanceof DOMException` is false. Match the platform error shape instead
 * so cancellation during route and component lifecycle changes never becomes resource error UI. */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  )
}

/** React error boundaries only catch errors thrown while rendering. Query effects therefore keep
 * the original failure in state and call this during render instead of throwing from a rejected
 * promise, which would become an unhandled rejection. */
export function throwIfUnauthorized(error: unknown): void {
  if (isUnauthorizedApiError(error)) throw error
}

export async function errorCode(
  response: Response
): Promise<string | undefined> {
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

export async function api<T>(
  path: string,
  options: { signal?: AbortSignal | undefined } = {}
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    signal: options.signal ?? null
  })
  if (!response.ok)
    throw new ApiError(response.status, await errorCode(response))
  return (await response.json()) as T
}
export async function apiPost<T>(path: string, body: object): Promise<T> {
  const encoded = JSON.stringify(body)
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: encoded
    })
  } catch {
    // Mutation bodies carry an operation_id. A single transport retry reuses the
    // exact bytes, allowing the Catalog's idempotency boundary to resolve an
    // accepted request whose response was lost.
    response = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: encoded
    })
  }
  if (!response.ok)
    throw new ApiError(response.status, await errorCode(response))
  return (await response.json()) as T
}
