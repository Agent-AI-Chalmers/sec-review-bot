import type { IncomingMessage, ServerResponse } from 'http'
import type { App } from 'octokit'

export type NodeHttpMiddleware = (request: IncomingMessage, response: ServerResponse) => void

export type RepositoryReviewDispatchHandler = (args: {
  app: App
  request: IncomingMessage
  response: ServerResponse
}) => Promise<void>

interface AppHttpHandlerOptions {
  app: App
  port: string | number
  repository_review_dispatch_path: string
  repository_review_dispatch_handler: RepositoryReviewDispatchHandler
  webhook_middleware: NodeHttpMiddleware
}

function writeJson (response: ServerResponse, status_code: number, value: Record<string, unknown>): void {
  response.statusCode = status_code
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(value))
}

function requestUrlFromNodeRequest (request: IncomingMessage, port: string | number): URL | null {
  const requestPath = typeof request.url === 'string' && request.url.length > 0 ? request.url : '/'
  // Some probes/proxies send an empty Host header; treat that as missing and use a safe local fallback.
  const requestHost = typeof request.headers.host === 'string' && request.headers.host.trim().length > 0
    ? request.headers.host.trim()
    : `localhost:${port}`

  try {
    return new URL(requestPath, `http://${requestHost}`)
  } catch {
    return null
  }
}

export function createAppHttpHandler ({
  app,
  port,
  repository_review_dispatch_path,
  repository_review_dispatch_handler,
  webhook_middleware
}: AppHttpHandlerOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
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

    webhook_middleware(request, response)
  }
}
