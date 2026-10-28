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
  const sourceRunIds = Object.fromEntries(
    ['repository-review', 'pull-request-review', 'issue-review'].map(
      (workflow) => {
        const run = runs.find(
          (candidate) =>
            candidate.workflow === workflow &&
            candidate.source_platform === 'github' &&
            candidate.execution.status === 'succeeded' &&
            candidate.publication.status === 'published' &&
            candidate.artifact_storage?.status === 'available'
        )
        if (run === undefined)
          throw new Error(
            `dev fixtures need one completed GitHub ${workflow} run for memory provenance`
          )
        return [workflow, run.run_id]
      }
    )
  ) as Record<
    'repository-review' | 'pull-request-review' | 'issue-review',
    string
  >
  const handleMemory = createMemoryHandler(sourceRunIds)
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
