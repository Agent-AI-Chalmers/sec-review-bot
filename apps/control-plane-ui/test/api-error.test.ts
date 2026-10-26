import assert from 'node:assert/strict'
import test from 'node:test'

import {
  api,
  ApiError,
  isAbortError,
  isUnauthorizedApiError,
  throwIfUnauthorized
} from '../browser/shared/api-client.js'

test('only a 401 ApiError is classified as a UI session failure', () => {
  const unauthorized = new ApiError(401, 'unauthorized')

  assert.equal(isUnauthorizedApiError(unauthorized), true)
  assert.equal(isUnauthorizedApiError(new ApiError(403)), false)
  assert.equal(isUnauthorizedApiError(new Error('network unavailable')), false)
})

test('request cancellation is distinct from API and transport failures', () => {
  assert.equal(isAbortError(new DOMException('Aborted', 'AbortError')), true)
  assert.equal(isAbortError({ name: 'AbortError' }), true)
  assert.equal(isAbortError(Object.create({ name: 'AbortError' })), true)
  assert.equal(isAbortError('AbortError'), false)
  assert.equal(isAbortError({ name: 'Error' }), false)
  assert.equal(isAbortError(new ApiError(401, 'unauthorized')), false)
  assert.equal(isAbortError(new Error('network unavailable')), false)
})

test('api forwards AbortSignal and rejects cancellation without wrapping it', async () => {
  const originalFetch = globalThis.fetch
  const controller = new AbortController()
  let receivedSignal: AbortSignal | null | undefined
  globalThis.fetch = (_input, init): Promise<Response> => {
    receivedSignal = init?.signal
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'))
      })
    })
  }
  try {
    const request = api('/slow', { signal: controller.signal })
    controller.abort()
    await assert.rejects(request, isAbortError)
    assert.equal(receivedSignal, controller.signal)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an unauthorized query failure is rethrown unchanged for the ErrorBoundary', () => {
  const unauthorized = new ApiError(401, 'unauthorized')

  assert.throws(
    () => throwIfUnauthorized(unauthorized),
    (error) => error === unauthorized
  )
})

test('resource and transport failures remain available for local error UI', () => {
  assert.doesNotThrow(() => throwIfUnauthorized(new ApiError(404)))
  assert.doesNotThrow(() =>
    throwIfUnauthorized(new Error('network unavailable'))
  )
  assert.doesNotThrow(() => throwIfUnauthorized(undefined))
})
