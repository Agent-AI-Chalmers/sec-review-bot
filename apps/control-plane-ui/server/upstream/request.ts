import {
  readBoundedUpstreamBody,
  UpstreamResponseTooLargeError
} from '../http-response.js'

export interface UpstreamResult {
  status: number
  body: Buffer
}

export type UpstreamFailureKind = 'timeout' | 'too_large' | 'unavailable'

export class UpstreamRequestError extends Error {
  constructor(
    readonly kind: UpstreamFailureKind,
    options?: { cause?: unknown }
  ) {
    super(`Upstream request failed: ${kind}.`, options)
    this.name = 'UpstreamRequestError'
  }
}

interface UpstreamRequestOptions {
  timeoutMs: number
  maximumBytes: number
  signal?: AbortSignal
}

/**
 * One bounded upstream request: authentication stays with the caller, while the total
 * timeout, response-size budget, and failure classification stay the same everywhere.
 */
export async function requestUpstream(
  url: string,
  init: RequestInit,
  options: UpstreamRequestOptions
): Promise<UpstreamResult> {
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs)
  timeout.unref()
  const abortFromCaller = (): void => controller.abort()
  options.signal?.addEventListener('abort', abortFromCaller, { once: true })
  if (options.signal?.aborted) controller.abort()

  const failureKind = (): UpstreamFailureKind | undefined => {
    if (timedOut) return 'timeout'
    if (options.signal?.aborted) return undefined
    return 'unavailable'
  }

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    })
    try {
      const body = await readBoundedUpstreamBody(response, options.maximumBytes)
      return { status: response.status, body }
    } catch (error) {
      if (error instanceof UpstreamResponseTooLargeError)
        throw new UpstreamRequestError('too_large', { cause: error })
      const kind = failureKind()
      if (kind !== undefined)
        throw new UpstreamRequestError(kind, { cause: error })
      throw error
    }
  } catch (error) {
    if (error instanceof UpstreamRequestError) throw error
    const kind = failureKind()
    if (kind !== undefined)
      throw new UpstreamRequestError(kind, { cause: error })
    throw error
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abortFromCaller)
  }
}
