import type { IncomingMessage, ServerResponse } from 'node:http'

import { createMemoryHandler, type MemorySourceRuns } from './memory/routes.js'
import { createRunFixtures } from './runs/generate.js'
import { createRunsHandler } from './runs/routes.js'

export function createMockApiRouter(
  now: () => number
): (request: IncomingMessage, response: ServerResponse, next: () => void) => Promise<void> {
  const snapshot = now()
  const fixtures = createRunFixtures(snapshot)
  const { runs } = fixtures
  let signedIn = true
  const sourceRuns = Object.fromEntries(
    ['repository-review', 'pull-request-review', 'issue-review'].map((workflow) => {
      const run = runs.find(
        (candidate) =>
          candidate.workflow === workflow &&
          candidate.source_platform === 'github' &&
          candidate.execution.status === 'succeeded' &&
          candidate.publication.status === 'published' &&
          candidate.artifact_storage?.status === 'available'
      )
      if (run?.artifact_storage?.status !== 'available') {
        throw new Error(`mock API needs one completed GitHub ${workflow} run for memory provenance`)
      }
      return [workflow, { runId: run.run_id, archiveDigest: run.artifact_storage.artifact.digest }]
    })
  ) as MemorySourceRuns
  const handleMemory = createMemoryHandler(sourceRuns, snapshot, now)
  const handleRuns = createRunsHandler(fixtures, now)

  return async (request, response, next): Promise<void> => {
    if (!request.url?.startsWith('/api/')) {
      return next()
    }
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
