import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { expect, test } from 'vitest'
import type { App } from 'octokit'

import { createAppHttpHandler } from '../../../src/ingress/http/app-http-handler.js'
import { fakeApp as fakeGitHubApp } from '../../github-app-stubs.js'
import { githubJson } from '../../github-client.js'

/** A real App; the dispatch handler is stubbed in every test here, so its transport is unused. */
function unusedApp(): App {
  return fakeGitHubApp({ respond: () => githubJson({ id: 123 }) }).app
}

function requestFor(
  url: string,
  headers: Record<string, string> = { host: 'example.test' },
  chunks: Array<Buffer | string> = []
): IncomingMessage {
  const request = Readable.from(chunks) as IncomingMessage
  request.url = url
  request.headers = headers
  return request
}

function captureResponse(): ServerResponse & {
  statusCodeValue?: number
  body?: string
  headers: Record<string, string>
} {
  const response: {
    statusCode: number
    statusCodeValue?: number
    body?: string
    headers: Record<string, string>
    setHeader: (name: string, value: string) => unknown
    end: (body: string) => unknown
  } = {
    statusCode: 200,
    headers: {},
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value
      return this
    },
    end(body: string) {
      this.statusCodeValue = this.statusCode
      this.body = body
      return this
    }
  }
  return response as ServerResponse & {
    statusCodeValue?: number
    body?: string
    headers: Record<string, string>
  }
}

test('app HTTP handler routes repository dispatch requests before webhook middleware', async () => {
  const calls: string[] = []
  const handler = createAppHttpHandler({
    app: unusedApp(),
    port: 3000,
    repository_review_dispatch_path: '/repository-review-dispatch',
    repository_review_dispatch_handler: async () => {
      calls.push('dispatch')
    },
    webhook_middleware: () => {
      calls.push('webhook')
    }
  })

  await handler(
    requestFor('/repository-review-dispatch?scan=full'),
    captureResponse()
  )

  expect(calls).toStrictEqual(['dispatch'])
})

test('app HTTP handler delegates non-dispatch requests to webhook middleware', async () => {
  const calls: string[] = []
  const handler = createAppHttpHandler({
    app: unusedApp(),
    port: 3000,
    repository_review_dispatch_path: '/repository-review-dispatch',
    repository_review_dispatch_handler: async () => {
      calls.push('dispatch')
    },
    webhook_middleware: () => {
      calls.push('webhook')
    }
  })

  await handler(requestFor('/api/github/webhooks'), captureResponse())

  expect(calls).toStrictEqual(['webhook'])
})

test('app HTTP handler rejects webhook content lengths above the configured limit', async () => {
  const response = captureResponse()
  const handler = createAppHttpHandler({
    app: unusedApp(),
    port: 3000,
    repository_review_dispatch_path: '/repository-review-dispatch',
    repository_review_dispatch_handler: async () => {},
    webhook_max_body_bytes: 4,
    webhook_middleware: () => {
      throw new Error('webhook middleware should not be called')
    }
  })

  await handler(
    requestFor('/api/github/webhooks', {
      host: 'example.test',
      'content-length': '5'
    }),
    response
  )

  expect(response.statusCodeValue).toBe(413)
  expect(String(response.body)).toMatch(/too large/i)
})

test('app HTTP handler aborts streamed webhook bodies above the configured limit', async () => {
  const response = captureResponse()
  let middlewareBytes = 0
  const handler = createAppHttpHandler({
    app: unusedApp(),
    port: 3000,
    repository_review_dispatch_path: '/repository-review-dispatch',
    repository_review_dispatch_handler: async () => {},
    webhook_max_body_bytes: 4,
    webhook_middleware: (request) => {
      request.on('data', (chunk: Buffer) => {
        middlewareBytes += chunk.byteLength
      })
    }
  })
  const request = requestFor(
    '/api/github/webhooks',
    { host: 'example.test', 'transfer-encoding': 'chunked' },
    [Buffer.from('123'), Buffer.from('45')]
  )

  await handler(request, response)
  await new Promise<void>((resolve) => request.once('close', resolve))

  expect(response.statusCodeValue).toBe(413)
  expect(String(response.body)).toMatch(/too large/i)
  expect(request.destroyed).toBe(true)
  expect.assert(middlewareBytes <= 5)
})

test('app HTTP handler rejects malformed request URLs', async () => {
  const response = captureResponse()
  const handler = createAppHttpHandler({
    app: unusedApp(),
    port: 3000,
    repository_review_dispatch_path: '/repository-review-dispatch',
    repository_review_dispatch_handler: async () => {
      throw new Error('dispatch should not be called')
    },
    webhook_middleware: () => {
      throw new Error('webhook should not be called')
    }
  })

  await handler(requestFor('/', { host: 'bad host' }), response)

  expect(response.statusCodeValue).toBe(400)
  expect(response.headers['content-type']).toBe(
    'application/json; charset=utf-8'
  )
  expect(String(response.body)).toMatch(/Invalid request URL/)
})

test('app HTTP handler contains rejected async dispatch handlers', async () => {
  const response = captureResponse()
  const handler = createAppHttpHandler({
    app: unusedApp(),
    port: 3000,
    repository_review_dispatch_path: '/repository-review-dispatch',
    repository_review_dispatch_handler: async () => {
      throw new Error('request stream failed')
    },
    webhook_middleware: () => {}
  })

  await handler(requestFor('/repository-review-dispatch'), response)

  expect(response.statusCodeValue).toBe(500)
  expect(JSON.parse(String(response.body))).toStrictEqual({
    error: 'Internal server error.'
  })
})

test('a rejected asynchronous webhook middleware becomes an HTTP error', async () => {
  const response = captureResponse()
  const handler = createAppHttpHandler({
    app: unusedApp(),
    port: 3000,
    repository_review_dispatch_path: '/repository-review-dispatch',
    repository_review_dispatch_handler: async () => {},
    webhook_middleware: () => Promise.reject(new Error('webhook failed'))
  })

  await handler(requestFor('/api/github/webhooks'), response)

  expect(response.statusCodeValue).toBe(500)
  expect(response.body).toBe(
    JSON.stringify({ error: 'Internal server error.' })
  )
})
