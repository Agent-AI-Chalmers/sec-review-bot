import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import test from 'node:test'
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

  assert.deepStrictEqual(calls, ['dispatch'])
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

  assert.deepStrictEqual(calls, ['webhook'])
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

  assert.strictEqual(response.statusCodeValue, 413)
  assert.match(String(response.body), /too large/i)
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

  assert.strictEqual(response.statusCodeValue, 413)
  assert.match(String(response.body), /too large/i)
  assert.strictEqual(request.destroyed, true)
  assert.ok(middlewareBytes <= 5)
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

  assert.strictEqual(response.statusCodeValue, 400)
  assert.strictEqual(
    response.headers['content-type'],
    'application/json; charset=utf-8'
  )
  assert.match(String(response.body), /Invalid request URL/)
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

  assert.strictEqual(response.statusCodeValue, 500)
  assert.deepStrictEqual(JSON.parse(String(response.body)), {
    error: 'Internal server error.'
  })
})
