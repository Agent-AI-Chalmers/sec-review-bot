import type { IncomingMessage, ServerResponse } from 'http'
import type { App } from 'octokit'

import { logError } from '../../utils/logger.js'

export type NodeHttpMiddleware = (
  request: IncomingMessage,
  response: ServerResponse
) => void

export type RepositoryReviewDispatchHandler = (args: {
  app: App
  request: IncomingMessage
  response: ServerResponse
}) => Promise<void>

interface AppHttpHandlerOptions {
  app: App
  port: number
  repository_review_dispatch_path: string
  repository_review_dispatch_handler: RepositoryReviewDispatchHandler
  webhook_max_body_bytes?: number
  webhook_middleware: NodeHttpMiddleware
}

function writeJson(
  response: ServerResponse,
  status_code: number,
  value: Record<string, unknown>
): void {
  response.statusCode = status_code
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(value))
}

function requestUrlFromNodeRequest(
  request: IncomingMessage,
  port: number
): URL | null {
  const requestPath =
    typeof request.url === 'string' && request.url.length > 0
      ? request.url
      : '/'
  // Some probes/proxies send an empty Host header; treat that as missing and use a safe local fallback.
  const requestHost =
    typeof request.headers.host === 'string' &&
    request.headers.host.trim().length > 0
      ? request.headers.host.trim()
      : `localhost:${port}`

  try {
    return new URL(requestPath, `http://${requestHost}`)
  } catch {
    return null
  }
}

async function handleAppHttpRequest(
  {
    app,
    port,
    repository_review_dispatch_path,
    repository_review_dispatch_handler,
    webhook_max_body_bytes,
    webhook_middleware
  }: AppHttpHandlerOptions & { webhook_max_body_bytes: number },
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const requestUrl = requestUrlFromNodeRequest(request, port)
  if (requestUrl === null) {
    writeJson(response, 400, {
      error: 'Invalid request URL'
    })
    return
  }

  if (requestUrl.pathname === repository_review_dispatch_path) {
    await repository_review_dispatch_handler({
      app,
      request,
      response
    })
    return
  }

  const contentLength = request.headers['content-length']
  if (
    typeof contentLength === 'string' &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > webhook_max_body_bytes
  ) {
    writeJson(response, 413, {
      error: 'Webhook request body is too large.'
    })
    request.destroy()
    return
  }

  let receivedBytes = 0
  let rejected = false
  const cleanup = (): void => {
    request.off('data', enforceWebhookBodyLimit)
    request.off('end', cleanup)
    request.off('error', cleanup)
  }
  function enforceWebhookBodyLimit(chunk: Buffer | string): void {
    if (rejected) return
    receivedBytes += Buffer.isBuffer(chunk)
      ? chunk.byteLength
      : Buffer.byteLength(chunk)
    if (receivedBytes <= webhook_max_body_bytes) return
    rejected = true
    cleanup()
    if (!response.headersSent && !response.writableEnded) {
      writeJson(response, 413, {
        error: 'Webhook request body is too large.'
      })
    }
    request.destroy()
  }
  request.on('data', enforceWebhookBodyLimit)
  request.once('end', cleanup)
  request.once('error', cleanup)

  webhook_middleware(request, response)
}

export function createAppHttpHandler({
  app,
  port,
  repository_review_dispatch_path,
  repository_review_dispatch_handler,
  webhook_max_body_bytes = 1_048_576,
  webhook_middleware
}: AppHttpHandlerOptions): (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<void> {
  const options = {
    app,
    port,
    repository_review_dispatch_path,
    repository_review_dispatch_handler,
    webhook_max_body_bytes,
    webhook_middleware
  }
  return async (request, response) => {
    try {
      await handleAppHttpRequest(options, request, response)
    } catch (error) {
      logError('http_request_failed', {
        error,
        method: request.method,
        url: request.url
      })
      if (!response.headersSent && !response.writableEnded) {
        writeJson(response, 500, { error: 'Internal server error.' })
      } else if (!response.writableEnded) {
        response.destroy(error instanceof Error ? error : undefined)
      }
    }
  }
}
