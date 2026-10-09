import type { Plugin } from 'vite'

interface FixtureRun {
  run_id: string
  workflow: 'issue-review' | 'pull-request-review' | 'repository-review'
  status: string
  execution_status: 'preparing' | 'recovering' | 'queued' | 'running' | 'succeeded' | 'failed'
  publication_status: 'pending' | 'publishing' | 'published' | 'failed' | 'not_required'
  created_at: string
  updated_at: string
  published_at: string | null
  failure_code: string | null
  artifact_storage: object | null
}

interface FixtureStep {
  step_key: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'terminal_failed'
  failure_count: number
  remote_object_url: string | null
  failure_code: string | null
  failure_message: string | null
}

const artifact = (runId: string): object => ({
  status: 'available',
  artifact: {
    uri: `s3://sec-review/runs/${runId}/artifacts/diagnostic-tree.v1.tar.zst`,
    kind: 'diagnostic_bundle',
    digest: `sha256:${'0'.repeat(64)}`,
    media_type: 'application/zstd',
    size_bytes: 12_345
  }
})

const runs: FixtureRun[] = [
  {
    run_id: '018f6b7c-2d41-7a30-9000-000000000001',
    workflow: 'pull-request-review',
    status: 'published',
    execution_status: 'succeeded',
    publication_status: 'published',
    created_at: '2026-10-08T14:17:15.571Z',
    updated_at: '2026-10-08T14:19:43.909Z',
    published_at: '2026-10-08T14:19:43.909Z',
    failure_code: null,
    artifact_storage: artifact('018f6b7c-2d41-7a30-9000-000000000001')
  },
  {
    run_id: '018f6b7c-2d41-7a30-9000-000000000002',
    workflow: 'issue-review',
    status: 'publishing',
    execution_status: 'succeeded',
    publication_status: 'publishing',
    created_at: '2026-10-08T12:02:11.104Z',
    updated_at: '2026-10-08T12:07:54.601Z',
    published_at: null,
    failure_code: null,
    artifact_storage: artifact('018f6b7c-2d41-7a30-9000-000000000002')
  },
  {
    run_id: '018f6b7c-2d41-7a30-9000-000000000003',
    workflow: 'repository-review',
    status: 'publishing',
    execution_status: 'succeeded',
    publication_status: 'publishing',
    created_at: '2026-10-08T09:40:03.214Z',
    updated_at: '2026-10-08T09:58:19.772Z',
    published_at: null,
    failure_code: null,
    artifact_storage: artifact('018f6b7c-2d41-7a30-9000-000000000003')
  },
  {
    run_id: '018f6b7c-2d41-7a30-9000-000000000004',
    workflow: 'repository-review',
    status: 'failed',
    execution_status: 'succeeded',
    publication_status: 'failed',
    created_at: '2026-10-08T08:11:46.832Z',
    updated_at: '2026-10-08T08:29:10.118Z',
    published_at: null,
    failure_code: 'GITHUB_VALIDATION_REJECTED',
    artifact_storage: artifact('018f6b7c-2d41-7a30-9000-000000000004')
  },
  {
    run_id: '018f6b7c-2d41-7a30-9000-000000000005',
    workflow: 'issue-review',
    status: 'failed',
    execution_status: 'failed',
    publication_status: 'pending',
    created_at: '2026-10-08T07:03:28.002Z',
    updated_at: '2026-10-08T07:04:01.447Z',
    published_at: null,
    failure_code: 'RUNNER_EXECUTION_FAILED',
    artifact_storage: { status: 'unavailable' }
  },
  {
    run_id: '018f6b7c-2d41-7a30-9000-000000000006',
    workflow: 'pull-request-review',
    status: 'running',
    execution_status: 'running',
    publication_status: 'pending',
    created_at: '2026-10-08T06:42:17.510Z',
    updated_at: '2026-10-08T06:43:32.090Z',
    published_at: null,
    failure_code: null,
    artifact_storage: null
  }
]

const stepsByRun = new Map<string, FixtureStep[]>([
  [
    runs[0]!.run_id,
    [
      {
        step_key: 'pull-request:review',
        status: 'succeeded',
        failure_count: 0,
        remote_object_url: null,
        failure_code: null,
        failure_message: null
      }
    ]
  ],
  [
    runs[1]!.run_id,
    [
      {
        step_key: 'issue:draft-pr',
        status: 'failed',
        failure_count: 2,
        remote_object_url: null,
        failure_code: 'GITHUB_SECONDARY_RATE_LIMIT',
        failure_message: 'GitHub temporarily limited publication.'
      }
    ]
  ],
  [
    runs[2]!.run_id,
    [
      {
        step_key: 'repository:delivery:delivery-a',
        status: 'succeeded',
        failure_count: 0,
        remote_object_url: null,
        failure_code: null,
        failure_message: null
      },
      {
        step_key: 'repository:summary-comment',
        status: 'failed',
        failure_count: 1,
        remote_object_url: null,
        failure_code: null,
        failure_message: null
      }
    ]
  ],
  [
    runs[3]!.run_id,
    [
      {
        step_key: 'repository:delivery:delivery-a',
        status: 'terminal_failed',
        failure_count: 1,
        remote_object_url: null,
        failure_code: 'GITHUB_VALIDATION_REJECTED',
        failure_message: 'Validation failed.'
      }
    ]
  ]
])

/** Serve representative read-only states without a Control Plane or BFF. */
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
          response.end(JSON.stringify({ runs, next_cursor: null }))
          return
        }
        const stepsMatch = /^\/api\/runs\/([^/?]+)\/publication-steps$/.exec(request.url)
        if (stepsMatch) {
          const runId = decodeURIComponent(stepsMatch[1] ?? '')
          response.end(
            JSON.stringify({ run_id: runId, publication_steps: stepsByRun.get(runId) ?? [] })
          )
          return
        }
        const runMatch = /^\/api\/runs\/([^/?]+)$/.exec(request.url)
        if (runMatch) {
          const runId = decodeURIComponent(runMatch[1] ?? '')
          const run = runs.find((item) => item.run_id === runId)
          if (run) {
            response.end(JSON.stringify({ run }))
            return
          }
        }
        response.statusCode = 404
        response.end(JSON.stringify({ error: 'not_found' }))
      })
    }
  }
}
