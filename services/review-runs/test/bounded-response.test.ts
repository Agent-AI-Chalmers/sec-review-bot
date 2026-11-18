import { ReadableStream } from 'node:stream/web'
import { expect, test } from 'vitest'

import { ResponseTooLargeError, readBoundedResponseBody } from '../src/bounded-response.js'

/**
 * The budget is the only protection against an upstream answering with a page far larger than
 * asked for, so both the declared-length path and the streaming path must refuse — and the
 * streaming path must not first buffer what it is about to reject.
 */
test('a body within the budget is returned whole', async () => {
  const response = new Response('abcd', {
    headers: { 'content-length': '4' }
  })
  expect(await readBoundedResponseBody(response, 4)).toStrictEqual(
    new Uint8Array([97, 98, 99, 100])
  )
})

test('a declared length over the budget is refused without reading the body', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8))
    },
    cancel() {
      cancelled = true
    }
  })
  const response = new Response(stream, {
    headers: { 'content-length': '8' }
  })
  await expect(readBoundedResponseBody(response, 4)).rejects.toThrow(ResponseTooLargeError)
  expect(cancelled).toBe(true)
})

test('a body that grows past the budget mid-stream is refused', async () => {
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent += 1
      controller.enqueue(new Uint8Array(3))
      if (sent >= 3) {
        controller.close()
      }
    }
  })
  // No content-length: the declared-length check cannot help here.
  const response = new Response(stream)
  await expect(readBoundedResponseBody(response, 4)).rejects.toThrow(ResponseTooLargeError)
})

test('an empty body reads as no bytes', async () => {
  const response = new Response(null)
  expect(await readBoundedResponseBody(response, 4)).toStrictEqual(new Uint8Array(0))
})
