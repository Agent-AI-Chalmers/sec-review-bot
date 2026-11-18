import type { ServerResponse } from 'node:http'
import { expect, test } from 'vitest'

import { UpstreamRequestError } from '../server/upstream/request.js'
import {
  sendUpstreamFailure,
  upstreamFailure,
  writeUpstreamResult
} from '../server/upstream/relay.js'

/**
 * The console branches on these codes, so one failure kind must not translate into two
 * different answers depending on which route relayed it. The upstreams' names are the
 * only part of the answer that differs.
 */
test('upstream failure codes name the upstream that failed', () => {
  expect(upstreamFailure(new UpstreamRequestError('timeout'), 'review_runs')).toStrictEqual({
    status: 504,
    error: 'review_runs_timeout'
  })
  expect(upstreamFailure(new UpstreamRequestError('timeout'), 'memory_catalog')).toStrictEqual({
    status: 504,
    error: 'memory_catalog_timeout'
  })
  expect(upstreamFailure(new UpstreamRequestError('unavailable'), 'memory_catalog')).toStrictEqual({
    status: 502,
    error: 'memory_catalog_unavailable'
  })
})

test('an oversized upstream body is not attributed to one upstream', () => {
  const oversized = new UpstreamRequestError('too_large')
  expect(upstreamFailure(oversized, 'review_runs')).toStrictEqual({
    status: 502,
    error: 'upstream_response_too_large'
  })
  expect(upstreamFailure(oversized, 'memory_catalog')).toStrictEqual({
    status: 502,
    error: 'upstream_response_too_large'
  })
})

test('an unclassified failure is the ordinary upstream failure', () => {
  expect(upstreamFailure(new Error('boom'), 'review_runs')).toStrictEqual({
    status: 502,
    error: 'review_runs_unavailable'
  })
})

interface Captured {
  status: number
  headers: Record<string, string>
  body: string
}

function capture(): { response: ServerResponse; written: Captured } {
  const written: Captured = { status: 0, headers: {}, body: '' }
  const response = {
    writeHead(status: number, headers: Record<string, string>) {
      written.status = status
      written.headers = headers
      return response
    },
    end(body: string | Buffer) {
      written.body = Buffer.isBuffer(body) ? body.toString('utf8') : body
      return response
    }
  } as unknown as ServerResponse
  return { response, written }
}

test('a relayed upstream response keeps its status and body', () => {
  const { response, written } = capture()
  writeUpstreamResult(response, {
    status: 404,
    body: Buffer.from('{"error":"run_not_found"}')
  })
  expect(written.status).toBe(404)
  expect(written.body).toBe('{"error":"run_not_found"}')
  expect(written.headers['cache-control']).toBe(undefined)
})

test('a relayed response can be marked uncacheable', () => {
  const { response, written } = capture()
  writeUpstreamResult(
    response,
    { status: 200, body: Buffer.from('{}') },
    { cacheControl: 'no-store' }
  )
  expect(written.headers['cache-control']).toBe('no-store')
})

test('a failure is sent as the console reads it', () => {
  const { response, written } = capture()
  sendUpstreamFailure(response, 'review_runs', new UpstreamRequestError('timeout'))
  expect(written.status).toBe(504)
  expect(JSON.parse(written.body)).toStrictEqual({
    error: 'review_runs_timeout'
  })
})
