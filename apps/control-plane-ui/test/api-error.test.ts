import { expect, test, vi } from 'vitest'

import {
  api,
  ApiError,
  isAbortError,
  isUnauthorizedApiError,
  throwIfUnauthorized
} from '../browser/shared/api-client.js'

test('only a 401 ApiError is classified as a UI session failure', () => {
  const unauthorized = new ApiError(401, 'unauthorized')

  expect(isUnauthorizedApiError(unauthorized)).toBe(true)
  expect(isUnauthorizedApiError(new ApiError(403))).toBe(false)
  expect(isUnauthorizedApiError(new Error('network unavailable'))).toBe(false)
})

test('request cancellation is distinct from API and transport failures', () => {
  expect(isAbortError(new DOMException('Aborted', 'AbortError'))).toBe(true)
  expect(isAbortError({ name: 'AbortError' })).toBe(true)
  expect(isAbortError(Object.create({ name: 'AbortError' }))).toBe(true)
  expect(isAbortError('AbortError')).toBe(false)
  expect(isAbortError({ name: 'Error' })).toBe(false)
  expect(isAbortError(new ApiError(401, 'unauthorized'))).toBe(false)
  expect(isAbortError(new Error('network unavailable'))).toBe(false)
})

test('api forwards AbortSignal and rejects cancellation without wrapping it', async ({
  onTestFinished
}) => {
  const controller = new AbortController()
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
  )
  onTestFinished(() => fetch.mockRestore())

  const request = api('/slow', { signal: controller.signal })
  controller.abort()

  await expect(request).rejects.toSatisfy(isAbortError)
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    '/api/slow',
    expect.objectContaining({ signal: controller.signal })
  )
  expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal)
})

test('an unauthorized query failure is rethrown unchanged for the ErrorBoundary', () => {
  const unauthorized = new ApiError(401, 'unauthorized')

  expect(() => throwIfUnauthorized(unauthorized)).toThrow(
    expect.toSatisfy((error: unknown) => error === unauthorized)
  )
})

test('resource and transport failures remain available for local error UI', () => {
  expect(() => throwIfUnauthorized(new ApiError(404))).not.toThrow()
  expect(() => throwIfUnauthorized(new Error('network unavailable'))).not.toThrow()
  expect(() => throwIfUnauthorized(undefined)).not.toThrow()
})
