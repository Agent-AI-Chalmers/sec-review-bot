import type { Plugin } from 'vite'

type Workflow = 'issue-review' | 'pull-request-review' | 'repository-review'
type ExecutionStatus = 'preparing' | 'recovering' | 'queued' | 'running' | 'succeeded' | 'failed'
type PublicationStatus = 'pending' | 'publishing' | 'published' | 'failed' | 'not_required'
type ArtifactStatus = 'available' | 'unavailable' | 'failed'
type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'terminal_failed'

interface FixtureArtifact {
  status: ArtifactStatus
  artifact?: {
    kind: 'diagnostic_bundle'
    uri: string
    media_type: string
    digest: string
    size_bytes: number
  }
  error_code?: string
  message?: string
}

interface FixtureRun {
  run_id: string
  workflow: Workflow
  execution_status: ExecutionStatus
  publication_status: PublicationStatus
  created_at: string
  execution_updated_at: string
  publication_updated_at: string
  published_at: string | null
  failure_code: string | null
  artifact_storage: FixtureArtifact | null
}

interface FixtureStep {
  step_key: string
  status: StepStatus
  failure_count: number
  remote_object_url: string | null
  failure_code: string | null
  failure_message: string | null
}

/**
 * One reachable slice of a run's lifecycle. Every field here is implied by the
 * Control Plane's state machine; see `validateRun` for the invariants that make
 * the generated fixtures a truthful preview instead of arbitrary JSON.
 */
interface Scenario {
  execution_status: ExecutionStatus
  publication_status: PublicationStatus
  failure_code: string | null
  artifact: ArtifactStatus | null
  /** Milliseconds from admission to the last execution-side change. */
  executionMs: number
  /** Milliseconds from admission to the last publication-side change; omitted
   * when the publication row was never touched after admission. */
  publicationMs?: number
  /** Status of the run's single publication step, or null when none exists. */
  step: StepStatus | null
}

// Mirrors the Control Plane's own default page size, and holds more runs than one
// page so the console's paging is reachable without a backend.
const DEV_PAGE_SIZE = 50
const RUN_COUNT = 62
const BASE_TIME = Date.now() - 20 * 60 * 1000
const RUN_SPACING_MS = 3 * 60 * 60 * 1000

const WORKFLOWS: readonly Workflow[] = ['pull-request-review', 'issue-review', 'repository-review']
const STEP_KEYS: Record<Workflow, string> = {
  'issue-review': 'issue:draft-pr',
  'pull-request-review': 'pull-request:review',
  'repository-review': 'repository:delivery:delivery-a'
}
const STEP_URLS: Record<Workflow, string> = {
  'issue-review': 'https://github.com/octo/example/pull/142',
  'pull-request-review': 'https://github.com/octo/example/pull/42#pullrequestreview-1001',
  'repository-review': 'https://github.com/octo/example/pull/311'
}

// Ordered by lifecycle, then repeated with rotating workflows so the list shows
// a realistic spread rather than one run per state.
const SCENARIOS: readonly Scenario[] = [
  {
    execution_status: 'preparing',
    publication_status: 'pending',
    failure_code: null,
    artifact: null,
    executionMs: 95_000,
    step: null
  },
  {
    execution_status: 'queued',
    publication_status: 'pending',
    failure_code: null,
    artifact: null,
    executionMs: 48_000,
    step: null
  },
  {
    execution_status: 'running',
    publication_status: 'pending',
    failure_code: null,
    artifact: null,
    executionMs: 320_000,
    step: null
  },
  {
    execution_status: 'succeeded',
    publication_status: 'pending',
    failure_code: null,
    artifact: 'available',
    executionMs: 184_000,
    step: null
  },
  {
    execution_status: 'succeeded',
    publication_status: 'publishing',
    failure_code: null,
    artifact: 'available',
    executionMs: 152_000,
    publicationMs: 418_000,
    step: 'running'
  },
  {
    execution_status: 'succeeded',
    publication_status: 'published',
    failure_code: null,
    artifact: 'available',
    executionMs: 166_000,
    publicationMs: 503_000,
    step: 'succeeded'
  },
  {
    execution_status: 'succeeded',
    publication_status: 'failed',
    failure_code: 'GITHUB_VALIDATION_REJECTED',
    artifact: 'available',
    executionMs: 131_000,
    publicationMs: 377_000,
    step: 'terminal_failed'
  },
  {
    execution_status: 'recovering',
    publication_status: 'not_required',
    failure_code: 'SUBMISSION_STATE_UNCERTAIN',
    artifact: null,
    executionMs: 143_000,
    publicationMs: 143_000,
    step: null
  },
  {
    execution_status: 'failed',
    publication_status: 'not_required',
    failure_code: 'PREPARATION_INTERRUPTED',
    artifact: null,
    executionMs: 601_000,
    publicationMs: 601_000,
    step: null
  },
  {
    execution_status: 'failed',
    publication_status: 'not_required',
    failure_code: 'RUNNER_EXECUTION_FAILED',
    artifact: 'unavailable',
    executionMs: 74_000,
    publicationMs: 74_000,
    step: null
  }
]

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString()
const runId = (index: number): string =>
  `018f6b7c-2d41-7a30-9000-${String(index + 1).padStart(12, '0')}`

function artifactFor(run_id: string, kind: ArtifactStatus | null): FixtureArtifact | null {
  if (kind === null) return null
  if (kind === 'available') {
    return {
      status: 'available',
      artifact: {
        kind: 'diagnostic_bundle',
        uri: `s3://sec-review/runs/${run_id}/artifacts/diagnostic-tree.v1.tar.zst`,
        media_type: 'application/zstd',
        digest: `sha256:${'0'.repeat(64)}`,
        size_bytes: 12_345
      }
    }
  }
  if (kind === 'failed') {
    return { status: 'failed', error_code: 'ARTIFACT_UPLOAD_FAILED' }
  }
  return { status: 'unavailable', message: 'The runner reported no diagnostic bundle.' }
}

function stepsFor(scenario: Scenario, workflow: Workflow): FixtureStep[] {
  if (scenario.step === null) return []
  const failedStep = scenario.step === 'terminal_failed'
  return [
    {
      step_key: STEP_KEYS[workflow],
      status: scenario.step,
      failure_count: failedStep ? 1 : 0,
      remote_object_url: scenario.step === 'succeeded' ? STEP_URLS[workflow] : null,
      failure_code: failedStep ? scenario.failure_code : null,
      failure_message: failedStep ? 'GitHub rejected the publication payload.' : null
    }
  ]
}

/**
 * Rejects any generated run that the Control Plane could never produce. The
 * checks mirror the store's write paths: publication only starts after a
 * succeeded execution, every terminal failure marks the publication
 * `not_required` in the same transaction, and the diagnostic artifact is
 * reported only when the execution is terminal.
 */
function validateRun(run: FixtureRun): void {
  const fail = (reason: string): never => {
    throw new Error(`dev fixture ${run.run_id} describes an unreachable run: ${reason}`)
  }
  const execution = run.execution_status
  const publication = run.publication_status
  const startedPublication = ['publishing', 'published', 'failed'].includes(publication)

  if ((run.published_at !== null) !== (publication === 'published')) {
    fail('published_at is set exactly when the publication is published')
  }
  if (startedPublication && execution !== 'succeeded') {
    fail(`publication ${publication} requires a succeeded execution`)
  }
  if (execution === 'succeeded' && publication === 'not_required') {
    fail('a succeeded execution always has a publication to perform')
  }
  if (execution === 'failed' && publication !== 'not_required') {
    fail('a terminal execution failure leaves nothing to publish')
  }
  if (run.artifact_storage !== null && !['succeeded', 'failed'].includes(execution)) {
    fail('the diagnostic artifact is only reported at execution terminal')
  }
  const failedOnAnAxis = execution === 'failed' || publication === 'failed'
  if (failedOnAnAxis && run.failure_code === null) {
    fail('a terminal failure carries its failure code')
  }
  if (
    run.failure_code !== null &&
    !failedOnAnAxis &&
    execution !== 'recovering' // an uncertain submission keeps its code until recovery completes
  ) {
    fail('only a terminal failure or an uncertain submission carries a failure code')
  }
  if (run.created_at > run.execution_updated_at) {
    fail('execution_updated_at must not precede created_at')
  }
  if (run.created_at > run.publication_updated_at) {
    fail('publication_updated_at must not precede created_at')
  }
  if (publication !== 'pending' && run.execution_updated_at > run.publication_updated_at) {
    fail('a started publication must not precede the execution')
  }
  if (run.published_at !== null && run.published_at !== run.publication_updated_at) {
    fail('published_at is the completion time of the publication')
  }
}

const runs: FixtureRun[] = Array.from({ length: RUN_COUNT }, (_, index) => {
  const scenario = SCENARIOS[index % SCENARIOS.length]!
  const workflow = WORKFLOWS[index % WORKFLOWS.length]!
  const run_id = runId(index)
  const createdAt = BASE_TIME - index * RUN_SPACING_MS
  const executionUpdatedAt = createdAt + scenario.executionMs
  const publicationUpdatedAt =
    scenario.publicationMs === undefined ? createdAt : createdAt + scenario.publicationMs
  const published = scenario.publication_status === 'published'
  return {
    run_id,
    workflow,
    execution_status: scenario.execution_status,
    publication_status: scenario.publication_status,
    created_at: iso(createdAt),
    execution_updated_at: iso(executionUpdatedAt),
    publication_updated_at: iso(publicationUpdatedAt),
    published_at: published ? iso(publicationUpdatedAt) : null,
    failure_code: scenario.failure_code,
    artifact_storage: artifactFor(run_id, scenario.artifact)
  }
})

for (const run of runs) validateRun(run)

const stepsByRun = new Map<string, FixtureStep[]>(
  runs.map((run, index) => [
    run.run_id,
    stepsFor(SCENARIOS[index % SCENARIOS.length]!, run.workflow)
  ])
)

interface Cursor {
  createdAt: string
  runId: string
}

function decodeCursor(value: string | null): Cursor | null {
  if (value === null) return null
  const [createdAt, runId, extra] = Buffer.from(value, 'base64url').toString('utf8').split('|')
  if (createdAt === undefined || runId === undefined || extra !== undefined) return null
  return { createdAt, runId }
}

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
          const url = new URL(request.url, 'http://fixture.local')
          const limit = Number(url.searchParams.get('limit') ?? DEV_PAGE_SIZE)
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
            response.statusCode = 400
            response.end(JSON.stringify({ error: 'limit is invalid.', code: 'INVALID_QUERY' }))
            return
          }
          const cursorValue = url.searchParams.get('cursor')
          const cursor = decodeCursor(cursorValue)
          if (cursorValue !== null && cursor === null) {
            response.statusCode = 400
            response.end(JSON.stringify({ error: 'cursor is invalid.', code: 'INVALID_QUERY' }))
            return
          }
          const from = url.searchParams.get('from')
          const to = url.searchParams.get('to')
          const executionStatus = url.searchParams.get('execution_status')
          const publicationStatus = url.searchParams.get('publication_status')
          const workflow = url.searchParams.get('workflow')
          const filtered = runs.filter(
            (run) =>
              (executionStatus === null || run.execution_status === executionStatus) &&
              (publicationStatus === null || run.publication_status === publicationStatus) &&
              (from === null || run.created_at >= from) &&
              (to === null || run.created_at < to) &&
              (workflow === null || run.workflow === workflow) &&
              // Matches the store's `(created_at, run_id) < (cursor)` page walk.
              (cursor === null ||
                run.created_at < cursor.createdAt ||
                (run.created_at === cursor.createdAt && run.run_id < cursor.runId))
          )
          const page = filtered.slice(0, limit)
          const last = page.at(-1)
          const nextCursor =
            last === undefined || page.length < limit
              ? null
              : Buffer.from(`${last.created_at}|${last.run_id}`).toString('base64url')
          response.end(JSON.stringify({ runs: page, next_cursor: nextCursor }))
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
