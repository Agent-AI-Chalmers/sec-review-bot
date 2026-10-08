import type { Plugin } from 'vite'

const run = {
  run_id: '018f6b7c-2d41-7a30-9000-000000000001',
  workflow: 'pull-request-review',
  status: 'published',
  created_at: '2026-10-08T14:17:15.571Z',
  updated_at: '2026-10-08T14:19:43.909Z',
  published_at: '2026-10-08T14:19:43.909Z',
  failure_code: null,
  artifact_publication: {
    status: 'published',
    artifact: {
      uri: 's3://sec-review/runs/018f6b7c-2d41-7a30-9000-000000000001/artifacts/diagnostic-tree.v1.tar.zst',
      kind: 'diagnostic_bundle',
      digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000001',
      media_type: 'application/vnd.sec-review.diagnostic.v1+tar+zstd',
      size_bytes: 51200
    }
  }
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
                {
                  step_key: 'pull-request:review',
                  status: 'succeeded',
                  attempts: 0,
                  failure_code: null
                }
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
