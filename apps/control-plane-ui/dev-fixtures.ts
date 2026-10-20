import type { Plugin } from 'vite'

import type { ArtifactStorage, Run } from './src/api.js'

import { LIST_RUN_QUERY_PARAMS } from './src/list-run-query-params.js'

type Workflow = 'issue-review' | 'pull-request-review' | 'repository-review'
type ExecutionStatus =
  | 'pending'
  | 'uncertain'
  | 'disconnected'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'skipped'
  | 'failed'
type PublicationStatus =
  | 'pending'
  | 'publishing'
  | 'uncertain'
  | 'disconnected'
  | 'published'
  | 'failed'
  | 'skipped'
type PreparationStatus =
  | 'pending'
  | 'preparing'
  | 'uncertain'
  | 'disconnected'
  | 'submitted'
  | 'failed'
type NoticeStage = 'pending' | 'delivering' | 'delivered' | 'failed'
type ArtifactStatus = 'available' | 'unavailable' | 'failed'
type StepStatus =
  | 'pending'
  | 'running'
  | 'uncertain'
  | 'disconnected'
  | 'succeeded'
  | 'failed'
  | 'terminal_failed'

// The contract's own artifact union, not a look-alike: `available` is the only status that may
// carry `artifact`, and the fixtures must satisfy the same shape the console renders.
type FixtureArtifact = NonNullable<ArtifactStorage>

interface FixtureRun {
  run_id: string
  workflow: Workflow
  preparation: {
    status: PreparationStatus
    attempt_count: number
    started_at: string | null
    finished_at: string | null
    updated_at: string
    failure_code: string | null
    disconnect_reason: string | null
  }
  notices: Run['notices']
  execution: {
    status: ExecutionStatus
    started_at: string | null
    finished_at: string | null
    updated_at: string
  }
  publication: {
    status: PublicationStatus
    started_at: string | null
    finished_at: string | null
    updated_at: string
  }
  created_at: string
  failure_code: string | null
  artifact_storage: FixtureArtifact | null
}

/**
 * The fixtures are served as the console's own read responses, so their shape must be the
 * console's `Run` type exactly — not a hand-maintained look-alike that drifts from it.
 *
 * `validateRun` below checks that a fixture is internally *consistent* (a phase may not end
 * before it starts, a skipped run never started, and so on). That is a different question from
 * whether it is the *right shape*, and consistency alone silently tolerated a fixture that had
 * not been migrated to the nested axis objects: every field was still reachable, so nothing
 * failed, but the console rendered `undefined`. This alias makes the shape a compile-time fact:
 * widening, narrowing, or renaming a field on either side stops compiling here.
 */
type FixtureMatchesRun = FixtureRun extends Run ? true : false
type RunMatchesFixture = Run extends FixtureRun ? true : false
const _fixtureMatchesRun: FixtureMatchesRun = true
const _runMatchesFixture: RunMatchesFixture = true
void _fixtureMatchesRun
void _runMatchesFixture

interface FixtureStep {
  step_key: string
  status: StepStatus
  attempt_count: number
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
   * timestamps are derived, the way each publication step's `attempt_count` and remote
   * object are. */
  preparation_status: PreparationStatus
  /** The failure-notice stage the run is in, or null when its preparation did not fail.
   * This mirrors `step`: a free choice that only has meaning in one preparation state
   * (`failed`), exactly as `step` only has meaning once a publication has started. */
  preparation_notice: NoticeStage | null
  /** The attention-notice stage after exhausted submission recovery. It only applies to a
   * disconnected execution: the external task outcome is unknown, but telling the requester
   * that automation stopped still has its own delivery lifecycle. */
  execution_attention_notice?: NoticeStage
  /** The attention-notice stage after reconciliation of a publication step stopped. It only
   * applies to a disconnected publication, for the same reason as the execution one: the run
   * is not a failure, but someone has to be told automation stopped. */
  publication_attention_notice?: NoticeStage
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
  {
    // Recovery exhausted its replay budget without learning whether the Runner accepted this
    // submission. The execution has not started from Control Plane's point of view, publication
    // remains pending, and the queued attention notice is deliberately not a failure report.
    execution_status: 'disconnected',
    publication_status: 'pending',
    failure_code: 'SUBMISSION_STATE_UNCERTAIN',
    artifact: null,
    executionMs: 221_000,
    step: null,
    preparation_status: 'submitted',
    preparation_notice: null,
    execution_attention_notice: 'pending'
  },
  {
    execution_status: 'disconnected',
    publication_status: 'pending',
    failure_code: 'SUBMISSION_STATE_UNCERTAIN',
    artifact: null,
    executionMs: 221_000,
    step: null,
    preparation_status: 'submitted',
    preparation_notice: null,
    execution_attention_notice: 'delivering'
  },
  {
    execution_status: 'disconnected',
    publication_status: 'pending',
    failure_code: 'SUBMISSION_STATE_UNCERTAIN',
    artifact: null,
    executionMs: 221_000,
    step: null,
    preparation_status: 'submitted',
    preparation_notice: null,
    execution_attention_notice: 'delivered'
  },
  {
    execution_status: 'disconnected',
    publication_status: 'pending',
    failure_code: 'SUBMISSION_STATE_UNCERTAIN',
    artifact: null,
    executionMs: 221_000,
    step: null,
    preparation_status: 'submitted',
    preparation_notice: null,
    execution_attention_notice: 'failed'
  },
  // A run whose preparation exhausted its retries fails before execution, so the publication
  // is skipped. The failure-notice outbox is what the connector eventually delivers to the
  // user, and it walks pending -> delivering -> delivered (or `failed` when delivery could not
  // complete); each stage is a distinct operational moment, so each gets its own scenario. The
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
    preparation_notice: 'failed'
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
  },
  {
    // A completed run whose delivery had to be reconciled: the result is published, but only
    // after a retry. The table described each outcome once, which left the operator queue with a
    // single published shape; a second one keeps two parked runs from looking identical.
    execution_status: 'succeeded',
    publication_status: 'published',
    failure_code: null,
    artifact: 'available',
    executionMs: 247_000,
    publicationMs: 612_000,
    step: 'succeeded',
    preparation_status: 'submitted',
    preparation_notice: null
  },
  // The states below are reachable but were not represented, which taught the console a
  // narrower lifecycle than the Control Plane produces: an operator could never see what a
  // parked publication looks like, or what a preparation does while it is being re-established.
  {
    // A preparation whose claim lapsed: nobody knows whether the prepared input reached the
    // Control Plane, so the next claim has to re-establish that before rebuilding. Not a
    // failure, so the run stays pending on both later axes.
    execution_status: 'pending',
    publication_status: 'pending',
    failure_code: null,
    artifact: null,
    executionMs: 95_000,
    step: null,
    preparation_status: 'uncertain',
    preparation_notice: null
  },
  {
    // A publication step may have taken effect remotely and is being reconciled. The axis
    // reports that so an operator can find the run, while the rest of the publication is
    // unaffected; this is not a failure.
    execution_status: 'succeeded',
    publication_status: 'uncertain',
    failure_code: null,
    artifact: 'available',
    executionMs: 158_000,
    publicationMs: 402_000,
    step: 'uncertain',
    preparation_status: 'submitted',
    preparation_notice: null
  },
  {
    // Reconciliation of that step stopped without an answer: the run is parked for an operator,
    // and the queued notice is an attention notice rather than a failure report.
    execution_status: 'succeeded',
    publication_status: 'disconnected',
    failure_code: null,
    artifact: 'available',
    executionMs: 158_000,
    publicationMs: 402_000,
    step: 'disconnected',
    preparation_status: 'submitted',
    preparation_notice: null,
    publication_attention_notice: 'pending'
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
  axis: 'execution' | 'preparation' | 'publication'
  from_status: string | null
  to_status: string
  failure_code: string | null
  occurred_at: string
}> {
  let eventId = 0
  const push = (
    axis: 'execution' | 'preparation' | 'publication',
    from: string | null,
    to: string,
    at: string,
    reason: string | null = null
  ): ReturnType<typeof eventsFor>[number] => ({
    event_id: ++eventId,
    axis,
    from_status: from,
    to_status: to,
    failure_code: reason,
    occurred_at: at
  })
  const events = [
    push('execution', null, 'pending', run.created_at),
    push('preparation', null, 'preparing', run.created_at),
    push('publication', null, 'pending', run.created_at)
  ]
  if (run.preparation !== null && run.preparation.status !== 'preparing') {
    events.push(
      push(
        'preparation',
        'preparing',
        run.preparation.status,
        run.preparation.finished_at ??
          run.preparation.started_at ??
          run.created_at,
        run.preparation.status === 'failed'
          ? run.preparation.failure_code
          : null
      )
    )
  }
  if (
    run.execution.status === 'uncertain' ||
    run.execution.status === 'disconnected'
  ) {
    // An unresolved submission never reached `queued`: Control Plane moves `pending` straight to
    // `uncertain` when the Runner call's acceptance could not be confirmed. The recovery then
    // resolves it to `queued` or `failed`, which is why this originates at `pending`.
    events.push(
      push(
        'execution',
        'pending',
        'uncertain',
        run.execution.updated_at,
        'SUBMISSION_STATE_UNCERTAIN'
      )
    )
    if (run.execution.status === 'disconnected') {
      events.push(
        push(
          'execution',
          'uncertain',
          'disconnected',
          run.execution.updated_at,
          'SUBMISSION_RECOVERY_EXHAUSTED'
        )
      )
    }
  } else if (run.execution.started_at !== null) {
    events.push(
      push('execution', 'pending', 'queued', run.execution.started_at)
    )
    if (run.execution.status !== 'queued') {
      events.push(
        push(
          'execution',
          'queued',
          run.execution.status,
          run.execution.updated_at,
          run.execution.status === 'failed' ? run.failure_code : null
        )
      )
    }
  } else if (run.execution.status === 'skipped') {
    // The Runner was never called: execution was skipped because preparation failed, so no
    // failure reason rides on the runner axis.
    events.push(
      push('execution', 'pending', 'skipped', run.execution.updated_at)
    )
  }
  if (['publishing', 'published', 'failed'].includes(run.publication.status)) {
    events.push(
      push(
        'publication',
        'pending',
        run.publication.status,
        run.publication.finished_at ??
          run.publication.started_at ??
          run.created_at,
        run.publication.status === 'failed' ? run.failure_code : null
      )
    )
  } else if (run.publication.status === 'skipped') {
    events.push(
      push(
        'publication',
        'pending',
        'skipped',
        run.publication.finished_at ?? run.created_at
      )
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
 * `attempt_count` follows from whether that step ran. `failed` necessarily means the
 * retry budget was exhausted, so it is derived with more than one attempt rather than the
 * one attempt a still-live preparation has.
 */
function preparationFor(
  scenario: Scenario,
  createdAt: number
): FixtureRun['preparation'] {
  const status = scenario.preparation_status
  // `pending` has not been claimed yet, so the phase has no start; every other state was
  // reached by a claim. `submitted` and `failed` are terminal, so they also have an end.
  const startedAt = status === 'pending' ? null : createdAt
  const finishedAt =
    status === 'submitted' || status === 'failed'
      ? createdAt + Math.min(scenario.executionMs, 60_000)
      : null
  return {
    status,
    attempt_count: status === 'failed' ? 8 : 1,
    started_at: startedAt === null ? null : iso(startedAt),
    finished_at: finishedAt === null ? null : iso(finishedAt),
    // The axis keeps being written while a preparer owns it (claim heartbeats, input
    // checkpoints), so its write time is the phase end once terminal and "just now" while live.
    updated_at: iso(
      status === 'preparing'
        ? Date.now() - Math.min(5_000, scenario.executionMs)
        : (finishedAt ?? createdAt)
    ),
    failure_code: status === 'failed' ? scenario.failure_code : null,
    // Set by the derivation below, not by a scenario: a disconnected run is a state no scenario
    // describes, and adding it as one would shift every other run's (scenario, workflow) pairing.
    disconnect_reason: null
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
      // An attempt is spent by starting one, not by failing: `succeeded` and `failed` steps have
      // run once, and a step that exhausted its budget ran as many times as the budget allows.
      attempt_count: status === 'pending' ? 0 : failed ? 3 : 1,
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
  const execution = run.execution.status
  const preparation = run.preparation
  const publication = run.publication.status
  // `uncertain` and `disconnected` are mid-phase states, so a publication that reports one has
  // necessarily started: the axis reflects a step that may already have taken effect remotely.
  const startedPublication = [
    'publishing',
    'uncertain',
    'disconnected',
    'published',
    'failed'
  ].includes(publication)

  // Each axis records a start and an end, and the fixture must respect the same rules the store
  // enforces: a start exists once the phase has begun, an end exists once it is terminal, and
  // neither may be present on a phase that never got that far.
  const preparationStarted = preparation.status !== 'pending'
  if ((preparation.started_at !== null) !== preparationStarted) {
    fail('preparation.started_at is set exactly when the phase has begun')
  }
  const preparationFinished =
    preparation.status === 'submitted' || preparation.status === 'failed'
  if ((preparation.finished_at !== null) !== preparationFinished) {
    fail('preparation.finished_at is set exactly when the phase is terminal')
  }
  if (
    (run.execution.finished_at !== null) !==
    (execution === 'succeeded' ||
      execution === 'failed' ||
      execution === 'skipped')
  ) {
    fail('execution_finished_at is set exactly when the execution is terminal')
  }
  // `skipped` ends the axis without starting it: preparation failed before the Runner was ever
  // called, so there is an end but no `execution.started_at`. Every other terminal state ran.
  if (run.execution.finished_at !== null && execution !== 'skipped') {
    if (run.execution.started_at === null) {
      fail('an execution that ran to a terminal state must also have started')
    }
  }
  if (execution === 'skipped' && run.execution.started_at !== null) {
    fail('a skipped execution was never submitted, so it has no start')
  }
  if ((run.publication.started_at !== null) !== startedPublication) {
    fail('publication_started_at is set exactly when the publication has begun')
  }

  if (startedPublication && execution !== 'succeeded') {
    fail(`publication ${publication} requires a succeeded execution`)
  }
  const startedAt = Date.parse(run.created_at)
  for (const [name, value] of [
    ['preparation.started_at', preparation.started_at],
    ['preparation.finished_at', preparation.finished_at],
    ['execution.started_at', run.execution.started_at],
    ['execution_finished_at', run.execution.finished_at],
    ['publication_started_at', run.publication.started_at]
  ] as const) {
    if (value !== null && Date.parse(value) < startedAt) {
      fail(`${name} must not precede created_at`)
    }
  }
  if (
    preparation.started_at !== null &&
    preparation.finished_at !== null &&
    Date.parse(preparation.finished_at) < Date.parse(preparation.started_at)
  ) {
    fail('preparation must not end before it started')
  }
  if (
    preparation.started_at !== null &&
    Date.parse(preparation.updated_at) < Date.parse(preparation.started_at)
  ) {
    fail('preparation.updated_at must not precede preparation.started_at')
  }
  if (
    run.execution.started_at !== null &&
    run.execution.finished_at !== null &&
    Date.parse(run.execution.finished_at) < Date.parse(run.execution.started_at)
  ) {
    fail('execution must not end before it was submitted')
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
  if (
    (execution === 'uncertain' || execution === 'disconnected') &&
    publication !== 'pending'
  ) {
    // An unconfirmed submission may still be accepted, so it is not yet a conclusion that
    // nothing is publishable. Publication must stay `pending`; only a conclusive failure may
    // skip it, and the state machine has no `skipped -> pending` edge to undo an early skip.
    fail('an unconfirmed submission keeps its publication pending')
  }
  // A blocked run is the deliberate exception: coordination found preparation unfinished while
  // execution had already advanced, which is exactly the contradiction it refuses to resolve on
  // its own. That state is unreachable by a normal write path but reachable by a partial repair,
  // and the console has to be able to render it, so the fixture models it here.
  if (
    preparation.status !== 'submitted' &&
    execution !== 'pending' &&
    execution !== 'skipped' &&
    preparation.disconnect_reason === null
  ) {
    fail('only a pending or skipped run can have unfinished preparation')
  }
  if (preparation.status === 'failed' && execution !== 'skipped') {
    fail('a terminal preparation failure skips execution')
  }
  // `preparation_notice` is only meaningful while preparation is failed, exactly as `step`
  // is only meaningful once a publication has started: a scenario may name either without
  // the other, so the pairing is checked here rather than in the type.
  // A notice is queued by whichever axis ended the run, so the pairing is with the run being
  // over, not with preparation having failed. A run whose execution failed carries an execution
  // notice even though its preparation completed normally.
  const failedAxis =
    preparation.status === 'failed'
      ? 'preparation'
      : execution === 'failed'
        ? 'execution'
        : null
  if (failedAxis !== null && run.notices.length === 0) {
    fail(
      'a run that failed on an axis names the stage its failure notice reached'
    )
  }
  // A parked run is not a failed run, but the requester is still told that automation stopped,
  // so an attention notice exists for exactly those two parked states and nothing else.
  if (
    failedAxis === null &&
    execution !== 'disconnected' &&
    publication !== 'disconnected' &&
    run.notices.length > 0
  ) {
    fail('only a failed or disconnected run has a notice')
  }
  if (
    run.notices.length > 0 &&
    failedAxis !== null &&
    run.notices[0]?.axis !== failedAxis
  ) {
    fail('a failure notice names the axis that actually failed')
  }
  if (execution === 'disconnected') {
    const notice = run.notices[0]
    if (
      run.notices.length !== 1 ||
      notice?.kind !== 'attention' ||
      notice.axis !== 'execution' ||
      notice.reason_code !== 'SUBMISSION_RECOVERY_EXHAUSTED'
    ) {
      fail('a disconnected execution queues one execution attention notice')
    }
  }
  if (publication === 'disconnected') {
    const notice = run.notices[0]
    if (
      run.notices.length !== 1 ||
      notice?.kind !== 'attention' ||
      notice.axis !== 'publication'
    ) {
      fail('a disconnected publication queues one publication attention notice')
    }
  }
  if (
    preparation.status === 'submitted' &&
    ![
      'uncertain',
      'disconnected',
      'queued',
      'running',
      'succeeded',
      'failed'
    ].includes(execution)
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
    execution !== 'uncertain' &&
    execution !== 'disconnected' // an unconfirmed submission keeps its code
  ) {
    fail(
      'only a terminal failure or unconfirmed submission carries a failure code'
    )
  }
  if (run.created_at > run.execution.updated_at) {
    fail('execution.updated_at must not precede created_at')
  }
  if (
    (execution === 'pending' ||
      execution === 'uncertain' ||
      execution === 'disconnected' ||
      execution === 'skipped') !==
    (run.execution.started_at === null)
  ) {
    fail(
      'an unaccepted, pending, or skipped execution has no execution.started_at, and every other state has one'
    )
  }
  if (
    run.execution.started_at !== null &&
    run.execution.started_at < run.created_at
  ) {
    fail('execution.started_at must not precede created_at')
  }
  if (
    run.execution.started_at !== null &&
    run.execution.started_at > run.execution.updated_at
  ) {
    fail('execution.started_at must not follow execution.updated_at')
  }
  if (run.publication.finished_at !== null) {
    if (run.publication.finished_at < run.created_at) {
      fail('publication_finished_at must not precede created_at')
    }
    if (
      run.publication.started_at !== null &&
      run.publication.finished_at < run.publication.started_at
    ) {
      fail('a publication must not end before it started')
    }
  }
  if (
    run.publication.started_at !== null &&
    run.publication.started_at < run.execution.updated_at
  ) {
    fail('a started publication must not precede the execution it publishes')
  }
  // `updated_at` is the axis' write time, so it can never precede the start it moved past, and
  // it is what a running publication advances while its bounds stay fixed.
  if (run.publication.started_at !== null) {
    if (run.publication.updated_at < run.publication.started_at) {
      fail('publication.updated_at must not precede publication.started_at')
    }
    if (
      publication === 'publishing' &&
      run.publication.updated_at === run.publication.started_at
    ) {
      fail(
        'a running publication keeps being written, so updated_at moves past its start'
      )
    }
  }
  // A finished publication exists exactly for the terminal outcomes; a skipped one never
  // started, so it has an end but no start.
  const publicationFinished =
    publication === 'published' ||
    publication === 'failed' ||
    publication === 'skipped'
  if ((run.publication.finished_at !== null) !== publicationFinished) {
    fail(
      'publication_finished_at is set exactly when the publication is terminal'
    )
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

/** A stand-in for the comment URL GitHub returns when the notice is delivered.
 *
 * Only a delivered notice has one: it is the comment the requester can open, and inventing one
 * for a pending or failed delivery would show a link that goes nowhere.
 */
function noticeCommentUrl(status: NoticeStage): string | null {
  if (status !== 'delivered') return null
  // A fixed, obviously-example URL: the fixtures are not tied to a real issue, and a plausible
  // link would invite someone to click it expecting a real comment.
  return 'https://github.com/example/example/issues/1#issuecomment-1'
}

/** The notice a terminal failure or disconnected recovery queues.
 *
 * Publication failures are excluded deliberately: a run whose result could not be delivered is
 * still `failed` on that axis, but the fixture's scenario table does not distinguish "the step
 * failed" from "the run is over", and guessing would put a notice on runs the real store would
 * leave alone.
 */
function noticesFor(
  scenario: Scenario,
  preparation: { status: PreparationStatus; failure_code: string | null },
  execution: ExecutionStatus,
  publication: PublicationStatus
): FixtureRun['notices'] {
  if (preparation.status === 'failed' && scenario.preparation_notice !== null) {
    return [
      {
        notice_id: `fixture-${scenario.failure_code ?? 'none'}-preparation`,
        kind: 'failure',
        status: scenario.preparation_notice,
        axis: 'preparation',
        reason_code: preparation.failure_code,
        comment_url: noticeCommentUrl(scenario.preparation_notice)
      }
    ]
  }
  if (execution === 'failed') {
    return [
      {
        notice_id: `fixture-${scenario.failure_code ?? 'none'}-execution`,
        kind: 'failure',
        status: 'pending',
        axis: 'execution',
        reason_code: scenario.failure_code,
        comment_url: null
      }
    ]
  }
  if (execution === 'disconnected') {
    const status = scenario.execution_attention_notice
    if (status === undefined) {
      throw new Error(
        'a disconnected fixture must name its attention notice stage'
      )
    }
    return [
      {
        notice_id: `fixture-${scenario.failure_code ?? 'none'}-execution-attention`,
        kind: 'attention',
        status,
        axis: 'execution',
        reason_code: 'SUBMISSION_RECOVERY_EXHAUSTED',
        comment_url: noticeCommentUrl(status)
      }
    ]
  }
  if (publication === 'disconnected') {
    const status = scenario.publication_attention_notice
    if (status === undefined) {
      throw new Error(
        'a disconnected publication must name its attention notice stage'
      )
    }
    // Same reasoning as the execution one: the run is parked, not failed, and the notice
    // reports that automation stopped — so it is an attention notice, not a failure report.
    return [
      {
        notice_id: `fixture-${scenario.failure_code ?? 'none'}-publication-attention`,
        kind: 'attention',
        status,
        axis: 'publication',
        reason_code: 'PUBLICATION_RECONCILIATION_EXHAUSTED',
        comment_url: noticeCommentUrl(status)
      }
    ]
  }
  return []
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
  // `executionMs` is the execution phase's own duration, which is what the console shows. The
  // phase cannot start before preparation ends, so the axis ends at preparation's end plus this
  // duration. Previously the end was `createdAt + executionMs` while the start was capped at 60s,
  // so every run displayed `executionMs - 60s` of execution - a 247s scenario read as 187s.
  const executionStartedAt = createdAt + Math.min(scenario.executionMs, 60_000)
  const executionUpdatedAt = executionStartedAt + scenario.executionMs
  const publicationUpdatedAt =
    scenario.publicationMs === undefined
      ? createdAt
      : createdAt + scenario.publicationMs
  // `pending` has not been submitted. `uncertain` and `disconnected` have a submission whose
  // acceptance is unknown, so none of them has an execution start time to measure.
  const executionNeverRan =
    scenario.execution_status === 'pending' ||
    scenario.execution_status === 'uncertain' ||
    scenario.execution_status === 'disconnected' ||
    scenario.execution_status === 'skipped'
  // For an in-flight run the whole timeline is relative to "now", and `updated_at` is pinned a
  // few seconds before it, so `started_at` must be relative to that same instant rather than to
  // `createdAt + elapsed`: with a long `executionMs` the two formulas disagree and start drifts
  // past the observation time. An active run has by definition been observed after it started.
  // Execution starts right after preparation finishes, and ends `executionMs` later. Capping the
  // start instead (as this used to) made every run report `executionMs - 60s` of execution time:
  // a 247s scenario displayed as 187s, so the duration on screen was not the duration the
  // scenario described. Preparation's own end keeps its cap, because it only has to be shorter
  // than the phase after it, not equal to it.
  const submittedAt = executionNeverRan
    ? null
    : active
      ? Date.now() - Math.min(5_000, scenario.executionMs) - 1_000
      : executionStartedAt
  // Execution ends on a terminal state; `uncertain` is explicitly not terminal.
  const executionFinished =
    scenario.execution_status === 'succeeded' ||
    scenario.execution_status === 'failed' ||
    scenario.execution_status === 'skipped'
  // Publication begins when its work is first claimed, i.e. once execution succeeded and the
  // publication has moved past `pending`. A `skipped` publication never started.
  const publicationFinished =
    scenario.publication_status === 'published' ||
    scenario.publication_status === 'failed' ||
    scenario.publication_status === 'skipped'
  // Uncertain and disconnected are mid-phase: the publication has been claimed and at least
  // one step has run, so the phase has a start.
  const publicationStarted =
    scenario.publication_status === 'publishing' ||
    scenario.publication_status === 'uncertain' ||
    scenario.publication_status === 'disconnected' ||
    scenario.publication_status === 'published' ||
    scenario.publication_status === 'failed'
  // The publication cannot start before execution ended. Halfway between those two instants
  // keeps the fixture's own ordering honest without inventing a separate scenario field.
  const publicationStartedAt = publicationStarted
    ? Math.round((executionUpdatedAt + publicationUpdatedAt) / 2)
    : null
  const preparation = preparationFor(scenario, createdAt)
  const execution = scenario.execution_status
  return {
    run_id,
    workflow,
    preparation,
    created_at: iso(createdAt),
    execution: {
      status: execution,
      started_at: submittedAt === null ? null : iso(submittedAt),
      finished_at: executionFinished ? iso(executionUpdatedAt) : null,
      // An active run is polled continuously, so its last observation is "just now"; a terminal
      // run keeps the instant it finished. This lets the console show a realistic
      // "observed Ns ago".
      updated_at: iso(
        scenario.execution_status === 'queued' ||
          scenario.execution_status === 'running'
          ? Date.now() - Math.min(5_000, scenario.executionMs)
          : executionUpdatedAt
      )
    },
    publication: {
      status: scenario.publication_status,
      started_at:
        publicationStartedAt === null ? null : iso(publicationStartedAt),
      // Every terminal publication outcome has an end; `skipped` is terminal without having
      // started, and `pending`/`publishing` have not finished yet.
      finished_at: publicationFinished ? iso(publicationUpdatedAt) : null,
      updated_at: iso(publicationUpdatedAt)
    },
    failure_code: scenario.failure_code,
    artifact_storage: artifactFor(run_id, scenario.artifact),
    // A failed preparation queues the acknowledgement the connector delivers. Derived here rather
    // than stored on the scenario: the notice is a consequence of the failure, not an independent
    // choice the fixture should make.
    // Any axis that ends a run queues a notice, so the fixture derives one from whichever axis
    // actually failed. Modelling only the preparation case taught the console a narrower world
    // than the Control Plane produces.
    notices: noticesFor(
      scenario,
      preparation,
      execution,
      scenario.publication_status
    )
  }
})

// The operator queue, shaped exactly as coordination would leave it. `EXECUTION_ALREADY_ADVANCED`
// means an expired preparation lease could not be concluded because execution had already moved
// past `pending`: writing "the Runner never ran" would overwrite a real result. So the two runs
// below are put into that contradictory state - preparation still `preparing`, execution advanced,
// publication still waiting - rather than just being labelled with the code. A marker on a run
// whose axes are consistent would teach the console a state the Control Plane cannot produce.
// The two runs standing in for the queue are chosen by scenario, not by position: the shape this
// mutation needs is "execution really finished", so it borrows the first scenarios that already
// describe a completed execution (with its own duration and artifact) rather than inheriting
// whatever happens to sit at the front of the table. Taking `slice(0, 2)` used to land on
// `execution: pending` rows, and forcing them to `succeeded` produced a zero-second execution
// with no artifact - a run that reported success it could not have had.
// The mutation needs a run that both ran to completion AND published its result, because that is
// the shape it is meant to show: an unpublishable preparation that stopped nothing. A `pending`
// or `publishing` publication would reintroduce exactly the false impression this fixture exists
// to correct - that the result is waiting for the operator.
// Steps are built before the parked-run mutations below, because parking a publication means
// parking one of its steps: the axis is derived from its strongest step, so the steps have to
// exist before the axis can be described.
const stepsByRun = new Map<string, FixtureStep[]>(
  runs.map((run, index) => [
    run.run_id,
    stepsFor(SCENARIOS[index % SCENARIOS.length]!, run.workflow, index)
  ])
)

const BLOCKED_SCENARIO_INDEXES = SCENARIOS.map((scenario, index) =>
  scenario.execution_status === 'succeeded' &&
  scenario.publication_status === 'published'
    ? index
    : -1
)
  .filter((index) => index >= 0)
  .slice(0, 2)
const BLOCKED_RUN_COUNT = 2
const blockedIndexes = new Set<number>()
// Every run parked on any axis, including the execution and publication cases below.
const parkedIndexes = new Set<number>()
for (let position = 0; position < BLOCKED_RUN_COUNT; position += 1) {
  const scenarioIndex = BLOCKED_SCENARIO_INDEXES[position]
  if (scenarioIndex === undefined) break
  const index = runs.findIndex(
    (_, runIndex) => runIndex % SCENARIOS.length === scenarioIndex
  )
  if (index < 0) break
  const run = runs[index]!
  blockedIndexes.add(index)
  run.preparation.status = 'disconnected'
  // A run in this state has necessarily been claimed at least once, so the phase has a start.
  if (run.preparation.started_at === null)
    run.preparation.started_at = run.created_at
  run.preparation.finished_at = null
  run.preparation.failure_code = null
  run.notices = []
  run.preparation.disconnect_reason = 'EXECUTION_ALREADY_ADVANCED'
  // Execution keeps the start, end, and artifact its scenario already gave it: it really did
  // run to completion, and pretending otherwise would show success with no evidence. The
  // publication is left as the scenario wrote it - completed - because that is the point of
  // this run: publishing does not wait on preparation. Rewinding it to `pending` would imply
  // the result is waiting for the operator's decision, which it never is.
  // A run-level failure code would contradict a succeeded execution.
  run.failure_code = null
  parkedIndexes.add(index)
}

// The other two axes park too, and an operator has to be able to find them. They are built from
// runs that finished their earlier phases, because that is what the real paths require: an
// execution only disconnects after a submission went unconfirmed, and a publication only parks
// after its side effects started.
const executionParkedIndex = runs.findIndex(
  (run, index) =>
    !parkedIndexes.has(index) &&
    // Preparation must have completed normally: a run whose preparation is also disconnected
    // cannot resume execution, so building the sample from it would leave the fixtures with no
    // resumable run at all and the console's Resume action unreachable locally.
    run.preparation.status === 'submitted' &&
    run.execution.status === 'succeeded'
)
if (executionParkedIndex >= 0) {
  const run = runs[executionParkedIndex]!
  parkedIndexes.add(executionParkedIndex)
  // Execution is the parked axis; preparation completed normally, so the run got this far.
  run.execution.status = 'disconnected'
  run.execution.started_at = null
  run.execution.finished_at = null
  run.publication.status = 'pending'
  run.publication.started_at = null
  run.publication.finished_at = null
  // A disconnected execution has no result yet, so there is no diagnostic artifact to report.
  run.artifact_storage = null
  run.failure_code = null
  run.notices = noticesFor(
    {
      ...SCENARIOS[executionParkedIndex % SCENARIOS.length]!,
      execution_status: 'disconnected',
      execution_attention_notice: 'pending'
    },
    run.preparation,
    'disconnected',
    'pending'
  )
}

const publicationParkedIndex = runs.findIndex(
  (run, index) =>
    !parkedIndexes.has(index) && run.publication.status === 'published'
)
if (publicationParkedIndex >= 0) {
  const run = runs[publicationParkedIndex]!
  parkedIndexes.add(publicationParkedIndex)
  // The axis follows its strongest step, so a disconnected axis without a disconnected step
  // describes a state the store cannot produce: every step succeeded, so nothing is unsettled
  // and the publication would simply be published. The parked step is the one that ran out of
  // reconciliation attempts; the rest keep the result they already delivered.
  const parkedSteps = stepsByRun.get(run.run_id) ?? []
  const lastStep = parkedSteps[parkedSteps.length - 1]
  if (lastStep !== undefined) {
    lastStep.status = 'disconnected'
    lastStep.attempt_count = 3
    lastStep.remote_object_url = null
    lastStep.failure_code = 'GITHUB_TIMEOUT'
    lastStep.failure_message =
      'Reconciliation could not establish whether this step took effect.'
  }
  run.publication.status = 'disconnected'
  run.publication.finished_at = null
  run.failure_code = null
  run.notices = noticesFor(
    {
      ...SCENARIOS[publicationParkedIndex % SCENARIOS.length]!,
      publication_status: 'disconnected',
      publication_attention_notice: 'pending'
    },
    run.preparation,
    run.execution.status,
    'disconnected'
  )
}


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
      // Runs the operator abandoned while this dev server has been running. Remembering them is
      // what makes the abandon button actually work locally: the queue shrinks and the detail
      // page stops offering the decision, instead of the button being permanently inert.
      const abandoned = new Set<string>()
      // Runs the operator handed back to automatic recovery. The resume button has to do
      // something locally too, or the console teaches a decision that visibly fails: the real
      // endpoint moves the row to `uncertain` with a fresh budget, so the detail page must stop
      // reporting `disconnected` and the run must leave the operator queue.
      const resumed = new Set<string>()
      // The runs the mutation above parked, read from their own axes rather than from the index
      // set that produced them. Deriving from state is what lets all three axes appear in the
      // queue: a run parked on execution or publication is as invisible to an operator as one
      // parked on preparation if the list is built from a preparation-only source.
      const parkedAxis = (run: FixtureRun):
        | 'preparation'
        | 'execution'
        | 'publication'
        | null =>
        run.preparation.status === 'disconnected'
          ? 'preparation'
          : run.execution.status === 'disconnected'
            ? 'execution'
            : run.publication.status === 'disconnected'
              ? 'publication'
              : null
      const blockedRuns = (): Array<{
        run_id: string
        axis: 'preparation' | 'execution' | 'publication'
        reason:
          | 'EXECUTION_ALREADY_ADVANCED'
          | 'SUBMISSION_RECOVERY_EXHAUSTED'
          | 'PUBLICATION_RECONCILIATION_EXHAUSTED'
      }> =>
        runs.flatMap((run, index) => {
          // Only the runs this fixture deliberately parked are queued. A run whose state
          // merely happens to be `disconnected` (the lifecycle scenarios, repeated across the
          // page) is not an operator backlog: listing all of them turned four sample states into
          // thirteen queue entries. The parked ones are what an operator is actually shown.
          if (!parkedIndexes.has(index)) return []
          const axis = parkedAxis(run)
          if (axis === null) return []
          if (abandoned.has(run.run_id) || resumed.has(run.run_id)) return []
          return [
            {
              run_id: run.run_id,
              axis,
              reason:
                axis === 'preparation'
                  ? ('EXECUTION_ALREADY_ADVANCED' as const)
                  : axis === 'execution'
                    ? ('SUBMISSION_RECOVERY_EXHAUSTED' as const)
                    : ('PUBLICATION_RECONCILIATION_EXHAUSTED' as const)
            }
          ]
        })
      const blockedRunIds = (): string[] =>
        blockedRuns().map((block) => block.run_id)
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
                run.execution.status === executionStatus) &&
              (publicationStatus === null ||
                run.publication.status === publicationStatus) &&
              // Fixtures always carry a preparation summary (see `validateRun`), matching the
              // store, which never returns a run without one.
              (preparationStatus === null ||
                run.preparation?.status === preparationStatus) &&
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
        // Before the run-detail match below, which would otherwise read this fixed segment as a
        // run id. Mirrors `GET /v1/runs/parked`.
        const abandonMatch = /^\/api\/admin\/runs\/([^/?]+)\/abandon$/.exec(
          request.url
        )
        // Mirrors `POST /v1/admin/runs/{runId}/resume`: the same eligibility (a run in the
        // queue), the same credential, and the same transition to `uncertain`.
        const resumeMatch = /^\/api\/admin\/runs\/([^/?]+)\/resume$/.exec(
          request.url
        )
        if (request.method === 'POST' && resumeMatch !== null) {
          if (request.headers['x-control-plane-admin-token'] === undefined) {
            response.statusCode = 401
            response.end(JSON.stringify({ error: 'admin_token_required' }))
            return
          }
          const runId = decodeURIComponent(resumeMatch[1] ?? '')
          if (
            !blockedRunIds().includes(runId) ||
            abandoned.has(runId) ||
            resumed.has(runId)
          ) {
            response.statusCode = 409
            response.end(JSON.stringify({ error: 'not_disconnected' }))
            return
          }
          const run = runs.find((item) => item.run_id === runId)
          if (run === undefined) {
            response.statusCode = 404
            response.end(JSON.stringify({ error: 'not_found' }))
            return
          }
          // The same transition Control Plane performs: preparation returns to `uncertain`
          // with a fresh attempt budget, and the reason that parked it is cleared. The axes are
          // left as they are, because resuming asserts nothing about them.
          run.preparation.status = 'uncertain'
          run.preparation.disconnect_reason = null
          run.preparation.attempt_count = 0
          run.preparation.failure_code = null
          run.preparation.updated_at = new Date().toISOString()
          resumed.add(runId)
          response.end(JSON.stringify({ run }))
          return
        }
        if (request.method === 'POST' && abandonMatch !== null) {
          // Mirrors the real endpoint's contract closely enough for local use: an operator token
          // is required, the run must be in the queue, and success removes it from the queue.
          if (request.headers['x-control-plane-admin-token'] === undefined) {
            response.statusCode = 401
            response.end(JSON.stringify({ error: 'admin_token_required' }))
            return
          }
          const runId = decodeURIComponent(abandonMatch[1] ?? '')
          if (!blockedRunIds().includes(runId)) {
            response.statusCode = 409
            response.end(JSON.stringify({ error: 'not_blocked' }))
            return
          }
          const run = runs.find((item) => item.run_id === runId)
          if (run === undefined) {
            response.statusCode = 404
            response.end(JSON.stringify({ error: 'not_found' }))
            return
          }
          // The same transition the Control Plane performs: conclude the axes that were still
          // open, keep the execution result, and record why. Clearing only the marker would show
          // the operator a run that looks untouched after an irreversible decision.
          const now = new Date().toISOString()
          run.preparation.status = 'failed'
          run.preparation.failure_code = 'PREPARATION_ABANDONED'
          run.notices = [
            {
              notice_id: `fixture-${run.run_id}-abandoned`,
              kind: 'failure',
              status: 'pending',
              axis: 'preparation',
              reason_code: 'PREPARATION_ABANDONED',
              comment_url: null
            }
          ]
          run.preparation.finished_at = now
          run.preparation.status = 'failed'
          run.preparation.disconnect_reason = null
          if (
            run.publication.status === 'pending' ||
            run.publication.status === 'publishing'
          ) {
            run.publication.status = 'skipped'
            run.publication.finished_at = now
          }
          abandoned.add(runId)
          response.end(JSON.stringify({ run }))
          return
        }
        if (request.url === '/api/runs/parked') {
          // Synthetic: a blocked run is not a lifecycle stage any scenario can describe (it is
          // the contradictory shape coordination refuses to resolve), so it is invented here
          // rather than mutating a real run. The ids are real, so following one opens a detail
          // page that loads.
          response.end(JSON.stringify({ blocks: blockedRuns() }))
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
            // The run already carries its real axes. Forcing preparation to `disconnected` here
            // (as this used to) mislabelled every parked run as preparation-parked, including
            // the ones parked on execution or publication, and made their resume ineligible.
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
