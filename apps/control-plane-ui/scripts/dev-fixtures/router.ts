import type { IncomingMessage, ServerResponse } from 'node:http'

import { createMemoryHandler } from './memory/routes.js'
import { runs } from './runs/generate.js'
import { createRunsHandler } from './runs/routes.js'

export function createFixtureRouter(): (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void
) => Promise<void> {
  let signedIn = true
  const handleMemory = createMemoryHandler(
    runs.slice(0, 3).map((run) => run.run_id)
  )
  const handleRuns = createRunsHandler()

  return async (request, response, next): Promise<void> => {
    if (!request.url?.startsWith('/api/')) return next()
    response.setHeader('content-type', 'application/json')

    if (
      request.url === '/api/session' &&
      (request.method === 'POST' || request.method === 'DELETE')
    ) {
      signedIn = request.method === 'POST'
      response.statusCode = 204
      response.end()
      return
    }
    if (!signedIn) {
      response.statusCode = 401
      response.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    if (request.url.startsWith('/api/memory/')) {
      await handleMemory(request, response)
    } else {
      await handleRuns(request, response)
    }
    if (!response.writableEnded) {
      response.statusCode = 404
      response.end(JSON.stringify({ error: 'not_found' }))
    }
  }
}
