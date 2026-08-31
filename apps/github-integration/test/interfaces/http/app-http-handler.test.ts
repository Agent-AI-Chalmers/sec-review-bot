import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import test from 'node:test'
import type { App } from 'octokit'

import { createAppHttpHandler } from '../../../interfaces/http/app-http-handler.js'

function requestFor (url: string, headers: Record<string, string> = { host: 'example.test' }): IncomingMessage {
  const request = Readable.from([]) as IncomingMessage
  request.url = url
  request.headers = headers
  return request
}

function captureResponse (): ServerResponse & { statusCodeValue?: number, body?: string, headers: Record<string, string> } {
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
    setHeader (name: string, value: string) {
      this.headers[name.toLowerCase()] = value
      return this
    },
    end (body: string) {
      this.statusCodeValue = this.statusCode
      this.body = body
      return this
    }
  }
  return response as ServerResponse & { statusCodeValue?: number, body?: string, headers: Record<string, string> }
}

test('app HTTP handler routes repository dispatch requests before webhook middleware', async () => {
  const calls: string[] = []
  const handler = createAppHttpHandler({
    app: {} as App,
    port: 3000,
    repository_review_dispatch_path: '/repository-review-dispatch',
    repository_review_dispatch_handler: async () => {
      calls.push('dispatch')
    },
    webhook_middleware: () => {
      calls.push('webhook')
    }
  })

  await handler(requestFor('/repository-review-dispatch?scan=full'), captureResponse())

  assert.deepEqual(calls, ['dispatch'])
})

test('app HTTP handler delegates non-dispatch requests to webhook middleware', async () => {
  const calls: string[] = []
  const handler = createAppHttpHandler({
    app: {} as App,
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

  assert.deepEqual(calls, ['webhook'])
})

test('app HTTP handler rejects malformed request URLs', async () => {
  const response = captureResponse()
  const handler = createAppHttpHandler({
    app: {} as App,
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

  assert.equal(response.statusCodeValue, 400)
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
  assert.match(String(response.body), /Invalid request URL/)
})
