import type { Plugin } from 'vite'

import { LIST_RUN_QUERY_PARAMS } from './src/list-run-query-params.js'

type Workflow = 'issue-review' | 'pull-request-review' | 'repository-review'
type ExecutionStatus =
  | 'pending'
  | 'uncertain'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'skipped'
  | 'failed'
type PublicationStatus =
  'pending' | 'publishing' | 'published' | 'failed' | 'skipped'
type PreparationStatus = 'pending' | 'preparing' | 'submitted' | 'failed'
type NoticeStage = 'pending' | 'delivering' | 'delivered' | 'skipped'
type ArtifactStatus = 'available' | 'unavailable' | 'failed'
type StepStatus =
  'pending' | 'running' | 'succeeded' | 'failed' | 'terminal_failed'

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
  preparation: {
    status: PreparationStatus
    attempt_count: number
    updated_at: string
    failure_code: string | null
    failure_notice_status: NoticeStage | null
  }
  execution_status: ExecutionStatus
  publication_status: PublicationStatus
  created_at: string
  submitted_at: string | null
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
  /** Where the run's preparation stopped. Like the two status axes above, this is the one
   * free choice the scenario makes about preparation; its attempt count, failure code, and
   * timestamps are derived, the way each publication step's `failure_count` and remote
   * object are. */
  preparation_status: PreparationStatus
  /** The failure-notice stage the run is in, or null when its preparation did not fail.
   * This mirrors `step`: a free choice that only has meaning in one preparation state
   * (`failed`), exactly as `step` only has meaning once a publication has started. */
  preparation_notice: NoticeStage | null
  /** Status of the run's single publication step, or null when none exists. */
  step: StepStatus | null
}

// Mirrors the Control Plane's own default page size, and holds more runs than one
// page so the console's paging is reachable without a backend.
const DEV_PAGE_SIZE = 50

/** The query parameters Control Plane's `listRuns` declares (generated from the contract).
 * The fixture mirrors the API's strictness: a parameter outside this set is rejected, so
 * local development matches the deployed contract instead of quietly accepting fields
 * production refuses. */
const DECLARED_QUERY_PARAMS = new Set<string>(LIST_RUN_QUERY_PARAMS)
const RUN_COUNT = 62
const BASE_TIME = Date.now() - 20 * 60 * 1000
const RUN_SPACING_MS = 3 * 60 * 60 * 1000

const WORKFLOWS: readonly Workflow[] = [
  'pull-request-review',
  'issue-review',
  'repository-review'
]
/**
 * The steps each workflow actually initializes, in publication order:
 * pull-request reviews publish one review, issue reviews always publish a summary
 * comment plus a draft PR when there is a patch, and repository reviews publish one
 * step per delivery plus two summaries.
 */
function stepKeysFor(workflow: Workflow, index: number): string[] {
  if (workflow === 'pull-request-review') return ['pull-request:review']
  if (workflow === 'issue-review') {
    return index % 3 === 0
      ? ['issue:draft-pr', 'issue:summary-comment']
      : ['issue:summary-comment']
  }
  const deliveries = 1 + (index % 2)
  return [
    ...Array.from(
      { length: deliveries },
      (_, position) => `repository:delivery:combined-${digest(index, position)}`
    ),
    'repository:summary-issue',
    'repository:summary-comment'
  ]
}

const REMOTE_ROOT = 'https://github.com/octo/example'

function remoteUrlFor(stepKey: string, index: number): string {
  if (stepKey.startsWith('issue:draft-pr'))
    return `${REMOTE_ROOT}/pull/${200 + index}`
  if (stepKey === 'issue:summary-comment') {
    return `${REMOTE_ROOT}/issues/${100 + index}#issuecomment-${900 + index}`
  }
  if (stepKey === 'pull-request:review') {
    return `${REMOTE_ROOT}/pull/42#pullrequestreview-${1000 + index}`
  }
  if (stepKey.startsWith('repository:delivery'))
    return `${REMOTE_ROOT}/pull/${300 + index}`
  return `${REMOTE_ROOT}/issues/${50 + index}#issuecomment-${800 + index}`
}

// Ordered by lifecycle, then repeated with rotating workflows so the list shows
// a realistic spread rather than one run per state.
const SCENARIOS: readonly Scenario[] = [
  {
    execution_status: 'pending',
    publication_status: 'pending',
    failure_code: null,
    artifact: null,
    executionMs: 95_000,
    step: null,
    preparation_status: 'preparing',
    preparation_notice: null
  },
  {
    execution_status: 'pending',
    publication_status: 'pending',
    failure_code: null,
    artifact: null,
    executionMs: 95_000,
    step: null,
    // A preparation that lost its claim and was returned to `pending`: it has already been
    // attempted at least once, which is why its attempt count is not zero.
    preparation_status: 'pending',
    preparation_notice: null
  },
  {
    execution_status: 'queued',
    publication_status: 'pending',
    failure_code: null,
    artifact: null,
    executionMs: 48_000,
    step: null,
    preparation_status: 'submitted',
    preparation_notice: null
  },
  {
    execution_status: 'running',
    publication_status: 'pending',
    failure_code: null,
    artifact: null,
    executionMs: 320_000,
    step: null,
    preparation_status: 'submitted',
    preparation_notice: null
  },
  {
    execution_status: 'succeeded',
    publication_status: 'pending',
    failure_code: null,
    artifact: 'available',
    executionMs: 184_000,
    step: null,
    preparation_status: 'submitted',
    preparation_notice: null
  },
  {
    execution_status: 'succeeded',
    publication_status: 'publishing',
    failure_code: null,
    artifact: 'available',
    executionMs: 152_000,
    publicationMs: 418_000,
    step: 'running',
    preparation_status: 'submitted',
    preparation_notice: null
  },
  {
    execution_status: 'succeeded',
    publication_status: 'published',
    failure_code: null,
    artifact: 'available',
    executionMs: 166_000,
    publicationMs: 503_000,
    step: 'succeeded',
    preparation_status: 'submitted',
    preparation_notice: null
  },
  {
    execution_status: 'succeeded',
    publication_status: 'failed',
    failure_code: 'GITHUB_VALIDATION_REJECTED',
    artifact: 'available',
    executionMs: 131_000,
    publicationMs: 377_000,
    step: 'terminal_failed',
    preparation_status: 'submitted',
    preparation_notice: null
  },
  {
    // Submission result unknown: not a failure, a recovery will resolve it. Publication stays
    // `pending` because an accepted submission could still produce a publishable result; only a
    // conclusive non-publishable outcome may skip it.
    execution_status: 'uncertain',
    publication_status: 'pending',
    failure_code: 'SUBMISSION_STATE_UNCERTAIN',
    artifact: null,
    executionMs: 143_000,
    step: null,
    preparation_status: 'submitted',
    preparation_notice: null
  },
  // A run whose preparation exhausted its retries fails before execution, so the publication
  // is skipped. The failure-notice outbox is what the connector eventually delivers to the
  // user, and it walks pending -> delivering -> delivered (or `skipped` when a notice is ruled
  // out); each stage is a distinct operational moment, so each gets its own scenario. The
  // state and the notice stage are the only free choices here; the attempt count and failure
  // code are derived, so an exhausted preparation cannot be written as "attempted once".
  {
    execution_status: 'skipped',
    publication_status: 'skipped',
    failure_code: 'PREPARATION_RETRY_EXHAUSTED',
    artifact: null,
    executionMs: 601_000,
    publicationMs: 601_000,
    step: null,
    preparation_status: 'failed',
    preparation_notice: 'pending'
  },
  {
    execution_status: 'skipped',
    publication_status: 'skipped',
    failure_code: 'PREPARATION_RETRY_EXHAUSTED',
    artifact: null,
    executionMs: 601_000,
    publicationMs: 601_000,
    step: null,
    preparation_status: 'failed',
    preparation_notice: 'delivering'
  },
  {
    execution_status: 'skipped',
    publication_status: 'skipped',
    failure_code: 'PREPARATION_RETRY_EXHAUSTED',
    artifact: null,
    executionMs: 601_000,
    publicationMs: 601_000,
    step: null,
    preparation_status: 'failed',
    preparation_notice: 'delivered'
  },
  {
    execution_status: 'skipped',
    publication_status: 'skipped',
    failure_code: 'PREPARATION_RETRY_EXHAUSTED',
    artifact: null,
    executionMs: 601_000,
    publicationMs: 601_000,
    step: null,
    preparation_status: 'failed',
    preparation_notice: 'skipped'
  },
  {
    // A freshly queued run: a plain in-flight state with no failure branch.
    execution_status: 'queued',
    publication_status: 'pending',
    failure_code: null,
    artifact: null,
    executionMs: 32_000,
    step: null,
    preparation_status: 'submitted',
    preparation_notice: null
  },
  {
    execution_status: 'failed',
    publication_status: 'skipped',
    failure_code: 'RUNNER_EXECUTION_FAILED',
    artifact: 'unavailable',
    executionMs: 74_000,
    publicationMs: 74_000,
    step: null,
    preparation_status: 'submitted',
    preparation_notice: null
  }
]

const iso = (milliseconds: number): string =>
  new Date(milliseconds).toISOString()
/**
 * Deterministic pseudo-random ids in the shape the Control Plane actually assigns
 * (`crypto.randomUUID()`, a v4 UUID). A time-ordered id would misrepresent what the
 * console receives and would falsely suggest that a prefix means something.
 */
function runId(index: number): string {
  let state = (index + 1) * 2654435761
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state
  }
  const block = (length: number): string =>
    next().toString(16).padStart(8, '0').slice(0, length)
  return `${block(8)}-${block(4)}-4${block(3)}-${'89ab'.charAt(next() % 4)}${block(3)}-${block(8)}${block(4)}`
}

/** Ten mixed hex characters, the shape the delivery planner derives from its cases. */
function digest(index: number, position: number): string {
  let state = (index + 1) * 40503 + position * 2654435761
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state
  }
  return `${next().toString(16).padStart(8, '0')}${next().toString(16).padStart(8, '0')}`.slice(
    0,
    10
  )
}

function artifactFor(
  run_id: string,
  kind: ArtifactStatus | null
): FixtureArtifact | null {
  if (kind === null) return null
  if (kind === 'available') {
    return {
      status: 'available',
      artifact: {
        kind: 'diagnostic_bundle',
        uri: `s3://sec-review/runs/${run_id}/artifacts/diagnostic-tree.v1.tar.zst`,
        media_type: 'application/tar+zstd',
        digest: `sha256:${'0'.repeat(64)}`,
        size_bytes: 12_345
      }
    }
  }
  if (kind === 'failed') {
    return { status: 'failed', error_code: 'ARTIFACT_UPLOAD_FAILED' }
  }
  return {
    status: 'unavailable',
    message: 'The runner reported no diagnostic bundle.'
  }
}

/**
 * A coherent coordination history for one fixture run, derived from its current state so the
 * console's History section has something truthful to show without a backend. The order and
 * axes mirror what the Control Plane writes: runner and preparation start at admission,
 * publication starts once execution succeeds.
 */
function eventsFor(run: FixtureRun): Array<{
  event_id: number
  axis: 'runner' | 'preparation' | 'publication' | 'notice'
  from_status: string | null
  to_status: string
  reason_code: string | null
  occurred_at: string
}> {
  let eventId = 0
  const push = (
    axis: 'runner' | 'preparation' | 'publication' | 'notice',
    from: string | null,
    to: string,
    at: string,
    reason: string | null = null
  ): ReturnType<typeof eventsFor>[number] => ({
    event_id: ++eventId,
    axis,
    from_status: from,
    to_status: to,
    reason_code: reason,
    occurred_at: at
  })
  const events = [
    push('runner', null, 'pending', run.created_at),
    push('preparation', null, 'preparing', run.created_at),
    push('publication', null, 'pending', run.created_at)
  ]
  if (run.preparation !== null && run.preparation.status !== 'preparing') {
    events.push(
      push(
        'preparation',
        'preparing',
        run.preparation.status,
        run.preparation.updated_at,
        run.preparation.status === 'failed'
          ? run.preparation.failure_code
          : null
      )
    )
  }
  if (run.execution_status === 'uncertain') {
    // An unresolved submission never reached `queued`: Control Plane moves `pending` straight to
    // `uncertain` when the Runner call's acceptance could not be confirmed. The recovery then
    // resolves it to `queued` or `failed`, which is why this originates at `pending`.
    events.push(
      push(
        'runner',
        'pending',
        'uncertain',
        run.execution_updated_at,
        'SUBMISSION_STATE_UNCERTAIN'
      )
    )
  } else if (run.submitted_at !== null) {
    events.push(push('runner', 'pending', 'queued', run.submitted_at))
    if (run.execution_status !== 'queued') {
      events.push(
        push(
          'runner',
          'queued',
          run.execution_status,
          run.execution_updated_at,
          run.execution_status === 'failed' ? run.failure_code : null
        )
      )
    }
  } else if (run.execution_status === 'skipped') {
    // The Runner was never called: execution was skipped because preparation failed, so no
    // failure reason rides on the runner axis.
    events.push(push('runner', 'pending', 'skipped', run.execution_updated_at))
  }
  if (run.preparation?.failure_notice_status) {
    events.push(push('notice', null, 'pending', run.preparation.updated_at))
    if (run.preparation.failure_notice_status !== 'pending') {
      events.push(
        push(
          'notice',
          'pending',
          run.preparation.failure_notice_status,
          run.preparation.updated_at
        )
      )
    }
  }
  if (['publishing', 'published', 'failed'].includes(run.publication_status)) {
    events.push(
      push(
        'publication',
        'pending',
        run.publication_status,
        run.publication_updated_at,
        run.publication_status === 'failed' ? run.failure_code : null
      )
    )
  } else if (run.publication_status === 'skipped') {
    events.push(
      push('publication', 'pending', 'skipped', run.publication_updated_at)
    )
  }
  return events.sort(
    (left, right) =>
      Date.parse(left.occurred_at) - Date.parse(right.occurred_at)
  )
}

/**
 * A scenario names only where preparation stopped; how many times it tried and which
 * failure it recorded follow from that state, the way each publication step's
 * `failure_count` follows from whether that step failed. `failed` necessarily means the
 * retry budget was exhausted, so it is derived with more than one attempt rather than the
 * one attempt a still-live preparation has.
 */
function preparationFor(
  scenario: Scenario,
  createdAt: number
): FixtureRun['preparation'] {
  const status = scenario.preparation_status
  return {
    status,
    attempt_count: status === 'failed' ? 8 : 1,
    updated_at: iso(createdAt + Math.min(scenario.executionMs, 60_000)),
    failure_code: status === 'failed' ? scenario.failure_code : null,
    failure_notice_status:
      status === 'failed' ? scenario.preparation_notice : null
  }
}

/**
 * Steps advance in order, so everything before the publication's current position has
 * already succeeded and only the last one can still be running or have failed.
 */
function stepsFor(
  scenario: Scenario,
  workflow: Workflow,
  index: number
): FixtureStep[] {
  const step = scenario.step
  if (step === null) return []
  const keys = stepKeysFor(workflow, index)
  const lastPosition = keys.length - 1
  return keys.map((step_key, position) => {
    const status: StepStatus =
      position < lastPosition
        ? 'succeeded'
        : step === 'running'
          ? 'running'
          : step
    const failed = status === 'terminal_failed'
    return {
      step_key,
      status,
      failure_count: failed ? 1 : 0,
      remote_object_url:
        status === 'succeeded' ? remoteUrlFor(step_key, index) : null,
      failure_code: failed ? scenario.failure_code : null,
      failure_message: failed
        ? 'GitHub rejected the publication payload.'
        : null
    }
  })
}

/**
 * Rejects any generated run that the Control Plane could never produce. The
 * checks mirror the store's write paths: publication only starts after a
 * succeeded execution, every terminal failure marks the publication
 * `skipped` in the same transaction, and the diagnostic artifact is
 * reported only when the execution is terminal.
 */
function validateRun(run: FixtureRun, steps: readonly FixtureStep[]): void {
  const fail = (reason: string): never => {
    throw new Error(
      `dev fixture ${run.run_id} describes an unreachable run: ${reason}`
    )
  }
  const execution = run.execution_status
  const preparation = run.preparation
  const publication = run.publication_status
  const startedPublication = ['publishing', 'published', 'failed'].includes(
    publication
  )

  if ((run.published_at !== null) !== (publication === 'published')) {
    fail('published_at is set exactly when the publication is published')
  }
  if (startedPublication && execution !== 'succeeded') {
    fail(`publication ${publication} requires a succeeded execution`)
  }
  if (execution === 'succeeded' && publication === 'skipped') {
    fail('a succeeded execution always has a publication to perform')
  }
  if (
    (execution === 'failed' || execution === 'skipped') &&
    publication !== 'skipped'
  ) {
    fail('a terminal execution leaves nothing to publish')
  }
  if (execution === 'skipped' && preparation.status !== 'failed') {
    fail('execution is skipped only when preparation failed before it ran')
  }
  if (execution === 'uncertain' && publication !== 'pending') {
    // An unconfirmed submission may still be accepted, so it is not yet a conclusion that
    // nothing is publishable. Publication must stay `pending`; only a conclusive failure may
    // skip it, and the state machine has no `skipped -> pending` edge to undo an early skip.
    fail('an uncertain submission keeps its publication pending')
  }
  if (
    preparation.status !== 'submitted' &&
    execution !== 'pending' &&
    execution !== 'skipped'
  ) {
    fail('only a pending or skipped run can have unfinished preparation')
  }
  if (preparation.status === 'failed' && execution !== 'skipped') {
    fail('a terminal preparation failure skips execution')
  }
  // `preparation_notice` is only meaningful while preparation is failed, exactly as `step`
  // is only meaningful once a publication has started: a scenario may name either without
  // the other, so the pairing is checked here rather than in the type.
  if (
    preparation.status === 'failed' &&
    preparation.failure_notice_status === null
  ) {
    fail('a failed preparation names the stage its failure notice reached')
  }
  if (
    preparation.status !== 'failed' &&
    preparation.failure_notice_status !== null
  ) {
    fail('only a failed preparation has a failure notice')
  }
  if (
    preparation.status === 'submitted' &&
    !['uncertain', 'queued', 'running', 'succeeded', 'failed'].includes(
      execution
    )
  ) {
    fail(
      'a submitted preparation means the run has moved on to the Runner lifecycle'
    )
  }
  if (
    run.artifact_storage !== null &&
    !['succeeded', 'failed'].includes(execution)
  ) {
    fail('the diagnostic artifact is only reported at execution terminal')
  }
  const failedOnAnAxis =
    execution === 'failed' ||
    execution === 'skipped' ||
    publication === 'failed'
  if (failedOnAnAxis && run.failure_code === null) {
    fail('a terminal failure carries its failure code')
  }
  if (
    run.failure_code !== null &&
    !failedOnAnAxis &&
    execution !== 'uncertain' // an unresolved submission keeps its code
  ) {
    fail(
      'only a terminal failure or an uncertain submission carries a failure code'
    )
  }
  if (run.created_at > run.execution_updated_at) {
    fail('execution_updated_at must not precede created_at')
  }
  if (
    (execution === 'pending' || execution === 'skipped') !==
    (run.submitted_at === null)
  ) {
    fail(
      'a pending or skipped execution has no submitted_at, and every other state has one'
    )
  }
  if (run.submitted_at !== null && run.submitted_at < run.created_at) {
    fail('submitted_at must not precede created_at')
  }
  if (
    run.submitted_at !== null &&
    run.submitted_at > run.execution_updated_at
  ) {
    fail('submitted_at must not follow the execution mtime')
  }
  if (run.created_at > run.publication_updated_at) {
    fail('publication_updated_at must not precede created_at')
  }
  if (
    publication !== 'pending' &&
    run.execution_updated_at > run.publication_updated_at
  ) {
    fail('a started publication must not precede the execution')
  }
  if (
    run.published_at !== null &&
    run.published_at !== run.publication_updated_at
  ) {
    fail('published_at is the completion time of the publication')
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      run.run_id
    )
  ) {
    fail('run ids are UUID v4, as the Control Plane assigns them')
  }

  if (steps.length > 0 && !startedPublication) {
    fail('publication steps only exist once the publication has started')
  }
  if (startedPublication && steps.length === 0) {
    fail('a started publication always has steps')
  }
  if (
    publication === 'published' &&
    steps.some((step) => step.status !== 'succeeded')
  ) {
    fail('a published run has only succeeded steps')
  }
  if (
    publication === 'publishing' &&
    steps.every((step) => step.status === 'succeeded')
  ) {
    fail('a publishing run still has work outstanding')
  }
  if (
    publication === 'failed' &&
    steps.filter((step) => step.status === 'terminal_failed').length !== 1
  ) {
    fail('a failed publication has exactly one terminal step')
  }
}

const runs: FixtureRun[] = Array.from({ length: RUN_COUNT }, (_, index) => {
  const scenario = SCENARIOS[index % SCENARIOS.length]!
  // Rotate the workflow offset as scenarios advance, so every (scenario, workflow) pair occurs
  // regardless of how many scenarios there are. A plain `index % len` freezes the pairing when
  // the two lengths share a factor, which silently dropped some combinations from the fixtures.
  const workflow =
    WORKFLOWS[
      (index + Math.floor(index / WORKFLOWS.length)) % WORKFLOWS.length
    ]!
  const run_id = runId(index)
  // An active run has necessarily been admitted a short time ago (it is still in flight), so
  // its timeline is anchored near now rather than at the newest historical slot. Otherwise a
  // running fixture would claim to have been executing for hours while also being polled just
  // seconds ago.
  const active = ['queued', 'running'].includes(scenario.execution_status)
  const createdAt = active
    ? Date.now() - (index % 5) * 60_000 - scenario.executionMs
    : BASE_TIME - index * RUN_SPACING_MS
  const executionUpdatedAt = createdAt + scenario.executionMs
  const publicationUpdatedAt =
    scenario.publicationMs === undefined
      ? createdAt
      : createdAt + scenario.publicationMs
  const published = scenario.publication_status === 'published'
  // A run is only submitted to the Runner once preparation completes; `pending` is exactly
  // the state before that, so its submitted_at stays null and the UI must not time execution.
  const executionNeverRan =
    scenario.execution_status === 'pending' ||
    scenario.execution_status === 'skipped'
  const submittedAt = executionNeverRan
    ? null
    : createdAt + Math.min(scenario.executionMs, 60_000)
  return {
    run_id,
    workflow,
    preparation: preparationFor(scenario, createdAt),
    execution_status: scenario.execution_status,
    publication_status: scenario.publication_status,
    created_at: iso(createdAt),
    submitted_at: submittedAt === null ? null : iso(submittedAt),
    // An active run is polled continuously, so its row mtime is "just now"; a terminal run
    // keeps the instant it finished. This lets the console show a realistic "observed Ns ago".
    execution_updated_at: iso(
      scenario.execution_status === 'queued' ||
        scenario.execution_status === 'running'
        ? Date.now() - Math.min(5_000, scenario.executionMs)
        : executionUpdatedAt
    ),
    publication_updated_at: iso(publicationUpdatedAt),
    published_at: published ? iso(publicationUpdatedAt) : null,
    failure_code: scenario.failure_code,
    artifact_storage: artifactFor(run_id, scenario.artifact)
  }
})

const stepsByRun = new Map<string, FixtureStep[]>(
  runs.map((run, index) => [
    run.run_id,
    stepsFor(SCENARIOS[index % SCENARIOS.length]!, run.workflow, index)
  ])
)

for (const run of runs) validateRun(run, stepsByRun.get(run.run_id) ?? [])
if (new Set(runs.map((run) => run.run_id)).size !== runs.length) {
  throw new Error('dev fixtures must not reuse a run id.')
}

interface Cursor {
  createdAt: string
  runId: string
}

function decodeCursor(value: string | null): Cursor | null {
  if (value === null) return null
  const [createdAt, runId, extra] = Buffer.from(value, 'base64url')
    .toString('utf8')
    .split('|')
  if (createdAt === undefined || runId === undefined || extra !== undefined)
    return null
  return { createdAt, runId }
}

/** Serve representative read-only states without a Control Plane or BFF. */
export function devFixtures(): Plugin {
  return {
    name: 'control-plane-ui-dev-fixtures',
    configureServer(server): void {
      // Fixtures have no credential to check, but they do track whether the console is
      // signed in, so that signing out reaches the sign-in form instead of reloading
      // straight back into the run list. Starts signed in: `dev:fixtures` exists to show
      // the console's real screens without an access token.
      let signedIn = true
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/api/')) return next()
        response.setHeader('content-type', 'application/json')
        // Mirrors the BFF's session route: signing in and out are the only two ways the
        // session changes, and both answer 204.
        if (
          request.url === '/api/session' &&
          (request.method === 'POST' || request.method === 'DELETE')
        ) {
          signedIn = request.method === 'POST'
          response.statusCode = 204
          response.end()
          return
        }
        // Matches the BFF: every other API call needs a session, and the console turns a
        // 401 into the sign-in form.
        if (!signedIn) {
          response.statusCode = 401
          response.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        if (request.url.startsWith('/api/runs?')) {
          const url = new URL(request.url, 'http://fixture.local')
          const unknown = [...url.searchParams.keys()].filter(
            (name) => !DECLARED_QUERY_PARAMS.has(name)
          )
          if (unknown.length > 0) {
            response.statusCode = 400
            response.end(
              JSON.stringify({
                error: 'unexpected query parameter',
                code: 'INVALID_QUERY'
              })
            )
            return
          }
          const limit = Number(url.searchParams.get('limit') ?? DEV_PAGE_SIZE)
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
            response.statusCode = 400
            response.end(
              JSON.stringify({
                error: 'limit is invalid.',
                code: 'INVALID_QUERY'
              })
            )
            return
          }
          const cursorValue = url.searchParams.get('cursor')
          const cursor = decodeCursor(cursorValue)
          if (cursorValue !== null && cursor === null) {
            response.statusCode = 400
            response.end(
              JSON.stringify({
                error: 'cursor is invalid.',
                code: 'INVALID_QUERY'
              })
            )
            return
          }
          const from = url.searchParams.get('from')
          const to = url.searchParams.get('to')
          const executionStatus = url.searchParams.get('execution_status')
          const publicationStatus = url.searchParams.get('publication_status')
          const preparationStatus = url.searchParams.get('preparation_status')
          const workflow = url.searchParams.get('workflow')
          const filtered = runs.filter(
            (run) =>
              (executionStatus === null ||
                run.execution_status === executionStatus) &&
              (publicationStatus === null ||
                run.publication_status === publicationStatus) &&
              (preparationStatus === null ||
                run.preparation.status === preparationStatus) &&
              (from === null || run.created_at >= from) &&
              (to === null || run.created_at < to) &&
              (workflow === null || run.workflow === workflow) &&
              // Matches the store's `(created_at, run_id) < (cursor)` page walk.
              (cursor === null ||
                run.created_at < cursor.createdAt ||
                (run.created_at === cursor.createdAt &&
                  run.run_id < cursor.runId))
          )
          const page = filtered.slice(0, limit)
          const last = page.at(-1)
          const nextCursor =
            last === undefined || page.length < limit
              ? null
              : Buffer.from(`${last.created_at}|${last.run_id}`).toString(
                  'base64url'
                )
          response.end(JSON.stringify({ runs: page, next_cursor: nextCursor }))
          return
        }
        const stepsMatch = /^\/api\/runs\/([^/?]+)\/publication-steps$/.exec(
          request.url
        )
        if (stepsMatch) {
          const runId = decodeURIComponent(stepsMatch[1] ?? '')
          response.end(
            JSON.stringify({
              run_id: runId,
              publication_steps: stepsByRun.get(runId) ?? []
            })
          )
          return
        }
        const eventsMatch = /^\/api\/runs\/([^/?]+)\/events$/.exec(request.url)
        if (eventsMatch) {
          const runId = decodeURIComponent(eventsMatch[1] ?? '')
          const run = runs.find((item) => item.run_id === runId)
          if (!run) {
            response.statusCode = 404
            response.end(JSON.stringify({ error: 'not_found' }))
            return
          }
          response.end(
            JSON.stringify({ run_id: run.run_id, events: eventsFor(run) })
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
