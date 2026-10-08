import type { Plugin } from 'vite'

const run = {
  run_id: 'review-20261009-001',
  workflow: 'pull-request-review',
  status: 'published',
  created_at: '2026-10-09T09:12:00.000Z',
  updated_at: '2026-10-09T09:38:24.000Z',
  published_at: '2026-10-09T09:38:24.000Z',
  failure_code: null,
  artifact_publication: { status: 'published', object_key: 'runs/review-20261009-001/result.json' }
}

/** Serve a complete read-only UI preview without a Control Plane or BFF. */
export function devFixtures(): Plugin {
  return {
    name: 'control-plane-ui-dev-fixtures',
    configureServer(server): void {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/api/')) return next()
        response.setHeader('content-type', 'application/json')
        if (request.url === '/api/session' && request.method === 'POST') {
          response.statusCode = 204
          response.end()
          return
        }
        if (request.url.startsWith('/api/runs?')) {
          response.end(JSON.stringify({ runs: [run], next_cursor: null }))
          return
        }
        if (request.url.endsWith('/publication-steps')) {
          response.end(
            JSON.stringify({
              publication_steps: [
                { step_key: 'github-review', status: 'succeeded', attempts: 1, failure_code: null }
              ]
            })
          )
          return
        }
        if (request.url.startsWith('/api/runs/')) {
          response.end(JSON.stringify({ run }))
          return
        }
        response.statusCode = 404
        response.end(JSON.stringify({ error: 'not_found' }))
      })
    }
  }
}
