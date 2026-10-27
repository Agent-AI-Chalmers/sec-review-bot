import type {
  ArtifactStorage,
  Run
} from '../../../browser/features/runs/api.js'

import { LIST_RUN_QUERY_PARAMS } from '../../../shared/list-run-query-params.js'
import scenarioData from '../data/run-scenarios.json' with { type: 'json' }
import { validateRun } from './validate.js'

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
type FixtureSourcePlatform = 'github' | 'gitlab' | 'unknown'

// The contract's own artifact union, not a look-alike: `available` is the only status that may
// carry `artifact`, and the fixtures must satisfy the same shape the console renders.
type FixtureArtifact = NonNullable<ArtifactStorage>

export interface FixtureRun {
  run_id: string
  workflow: Workflow
  connector_id: string
  source_platform: FixtureSourcePlatform
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
  execution_statistics: Run['execution_statistics']
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
type ContractShapedFixtureRun = Omit<FixtureRun, 'source_platform'> & {
  source_platform: Run['source_platform']
}
type FixtureMatchesRun = ContractShapedFixtureRun extends Run ? true : false
type RunMatchesFixture = Run extends ContractShapedFixtureRun ? true : false
const _fixtureMatchesRun: FixtureMatchesRun = true
const _runMatchesFixture: RunMatchesFixture = true
void _fixtureMatchesRun
void _runMatchesFixture

export interface FixtureStep {
  step_key: string
  status: StepStatus
  attempt_count: number
  remote_object_url: string | null
  failure_code: string | null
  failure_message: string | null
}

/**
 * One reachable slice of a run's lifecycle. Every field here is implied by the
 * Review Runs's state machine; see `validateRun` for the invariants that make
 * the generated fixtures a truthful preview instead of arbitrary JSON.
 */
export interface Scenario {
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

// Mirrors Review Runs' own default page size, and holds more runs than one
// page so the console's paging is reachable without a backend.
export const DEV_PAGE_SIZE = 50

/** The query parameters Review Runs's `listRuns` declares (generated from the contract).
 * The fixture mirrors the API's strictness: a parameter outside this set is rejected, so
 * local development matches the deployed contract instead of quietly accepting fields
 * production refuses. */
export const DECLARED_QUERY_PARAMS = new Set<string>(LIST_RUN_QUERY_PARAMS)
const RUN_COUNT = 62
export const BASE_TIME = Date.now() - 20 * 60 * 1000
const RUN_SPACING_MS = 3 * 60 * 60 * 1000

const WORKFLOWS: readonly Workflow[] = [
  'pull-request-review',
  'issue-review',
  'repository-review'
]

type StatisticsGroup = NonNullable<
  Run['execution_statistics']
>['groups'][number]

const STATISTICS_GROUPS: Record<Workflow, StatisticsGroup[]> = {
  'issue-review': [
    statisticsGroup('issue-analyzer', 1, 3_100, 550, 1_100, {
      passKind: 'initial',
      passIndex: 0
    }),
    statisticsGroup('issue-mitigator', 1, 3_400, 650, 1_200, {
      passKind: 'initial',
      passIndex: 0
    }),
    statisticsGroup('issue-verifier', 1, 2_500, 400, 800, {
      passKind: 'initial',
      passIndex: 0
    }),
    statisticsGroup('issue-mitigator', 1, 3_700, 750, 1_300, {
      passKind: 'feedback',
      passIndex: 1
    }),
    statisticsGroup('issue-verifier', 1, 2_800, 500, 1_000, {
      passKind: 'feedback',
      passIndex: 1
    })
  ],
  'pull-request-review': [
    statisticsGroup('pull-request-analyzer', 1, 3_200, 600, 1_000, {
      passKind: 'initial',
      passIndex: 0
    }),
    statisticsGroup('pull-request-mitigator', 1, 4_200, 800, 1_300, {
      passKind: 'initial',
      passIndex: 0
    }),
    statisticsGroup('pull-request-verifier', 1, 2_400, 400, 800, {
      passKind: 'initial',
      passIndex: 0
    }),
    statisticsGroup('pull-request-mitigator', 1, 2_400, 400, 800, {
      passKind: 'feedback',
      passIndex: 1
    }),
    statisticsGroup('pull-request-verifier', 1, 2_400, 450, 800, {
      passKind: 'feedback',
      passIndex: 1
    })
  ],
  'repository-review': [
    statisticsGroup('repository-discovery', 1, 2_800, 360, 1_100, {
      chunkId: 'discovery-chunk-0001'
    }),
    statisticsGroup('repository-discovery', 1, 2_700, 354, 1_000, {
      chunkId: 'discovery-chunk-0002'
    }),
    statisticsGroup('repository-discovery', 1, 2_700, 370, 1_000, {
      chunkId: 'discovery-chunk-0003'
    }),
    statisticsGroup('repository-triager', 1, 2_700, 400, 900, {
      passKind: 'draft',
      passIndex: 0,
      batchIndex: 1
    }),
    statisticsGroup('repository-triager', 1, 2_400, 400, 900, {
      passKind: 'draft',
      passIndex: 0,
      batchIndex: 2
    }),
    statisticsGroup('repository-triager', 1, 1_800, 300, 600, {
      passKind: 'refinement',
      passIndex: 1
    }),
    statisticsGroup('repository-analyzer', 2, 5_200, 1_000, 1_600, {
      caseId: '7d9a2f6c31b4e8',
      passKind: 'initial',
      passIndex: 0
    }),
    statisticsGroup('repository-cvss-v4-scorer', 1, 1_200, 225, 450, {
      caseId: '7d9a2f6c31b4e8',
      passKind: 'initial',
      passIndex: 0
    }),
    statisticsGroup('repository-mitigator', 1, 2_600, 500, 700, {
      caseId: '7d9a2f6c31b4e8',
      passKind: 'initial',
      passIndex: 0
    }),
    statisticsGroup('repository-verifier', 1, 2_900, 550, 800, {
      caseId: '7d9a2f6c31b4e8',
      passKind: 'initial',
      passIndex: 0
    }),
    statisticsGroup('repository-mitigator', 2, 5_000, 1_000, 1_500, {
      caseId: '7d9a2f6c31b4e8',
      passKind: 'feedback',
      passIndex: 1
    }),
    statisticsGroup('repository-verifier', 2, 5_400, 1_100, 1_700, {
      caseId: '7d9a2f6c31b4e8',
      passKind: 'feedback',
      passIndex: 1
    }),
    statisticsGroup('repository-analyzer', 2, 5_020, 1_100, 1_580, {
      caseId: 'c4e81a90d2f763',
      passKind: 'initial',
      passIndex: 0
    }),
    statisticsGroup('repository-cvss-v4-scorer', 1, 1_200, 225, 450, {
      caseId: 'c4e81a90d2f763',
      passKind: 'initial',
      passIndex: 0
    }),
    statisticsGroup('repository-mitigator', 1, 2_500, 500, 700, {
      caseId: 'c4e81a90d2f763',
      passKind: 'initial',
      passIndex: 0
    }),
    statisticsGroup('repository-verifier', 1, 2_600, 500, 700, {
      caseId: 'c4e81a90d2f763',
      passKind: 'initial',
      passIndex: 0
    }),
    statisticsGroup('repository-delivery-planner', 1, 1_600, 300, 400, {
      passKind: 'draft',
      passIndex: 0,
      batchIndex: 1
    }),
    statisticsGroup('repository-delivery-planner', 1, 1_000, 200, 300, {
      passKind: 'draft',
      passIndex: 0,
      batchIndex: 2
    }),
    statisticsGroup('repository-delivery-planner', 1, 900, 200, 300, {
      passKind: 'refinement',
      passIndex: 1
    })
  ]
}

function statisticsGroup(
  agent_name: string,
  model_call_count: number,
  input_tokens: number,
  output_tokens: number,
  cache_read_input_tokens: number,
  context: {
    caseId?: string
    deliveryId?: string
    passKind?: string
    passIndex?: number
    batchIndex?: number
    chunkId?: string
  } = {}
): StatisticsGroup {
  return {
    agent_name,
    case_id: context.caseId ?? null,
    delivery_id: context.deliveryId ?? null,
    pass_kind: context.passKind ?? null,
    pass_index: context.passIndex ?? null,
    batch_index: context.batchIndex ?? null,
    chunk_id: context.chunkId ?? null,
    provider: 'anthropic',
    model: 'deepseek-v4-pro',
    model_call_count,
    usage_reported_call_count: model_call_count,
    token_usage: {
      input_tokens,
      output_tokens,
      total_tokens: input_tokens + output_tokens,
      cache_read_input_tokens,
      cache_creation_input_tokens: null,
      reasoning_tokens: null
    }
  }
}

function executionStatisticsFor(
  workflow: Workflow,
  updatedAt: number,
  includeFeedback: boolean,
  index: number
): Run['execution_statistics'] {
  const baseGroups = STATISTICS_GROUPS[workflow].filter(
    (group) => includeFeedback || group.pass_kind !== 'feedback'
  )
  const groups =
    workflow === 'repository-review'
      ? [
          ...baseGroups,
          ...repositoryDeliveryIdsFor(index).map((deliveryId, position) =>
            statisticsGroup(
              'patch-synthesizer',
              1,
              2_700 + position * 400,
              540 + position * 120,
              700 + position * 200,
              { deliveryId }
            )
          )
        ]
      : baseGroups
  const sum = (read: (group: StatisticsGroup) => number | null): number =>
    groups.reduce((total, group) => total + (read(group) ?? 0), 0)
  return {
    reconciliation_status: 'settled',
    ingestion_status: 'settled',
    usage_coverage: 'complete_for_observed_calls',
    root_trace_count: groups.length,
    excluded_non_review_root_count: 0,
    observed_call_count: sum((group) => group.model_call_count),
    usage_reported_call_count: sum((group) => group.usage_reported_call_count),
    token_usage: {
      input_tokens: sum((group) => group.token_usage.input_tokens),
      output_tokens: sum((group) => group.token_usage.output_tokens),
      total_tokens: sum((group) => group.token_usage.total_tokens),
      cache_read_input_tokens: sum(
        (group) => group.token_usage.cache_read_input_tokens
      ),
      cache_creation_input_tokens: null,
      reasoning_tokens: null
    },
    groups,
    settled_at: iso(updatedAt + 65_000),
    updated_at: iso(updatedAt + 65_000)
  }
}

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
  return [
    ...repositoryDeliveryIdsFor(index).map(
      (deliveryId) => `repository:delivery:${deliveryId}`
    ),
    'repository:summary-issue',
    'repository:summary-comment'
  ]
}

function repositoryDeliveryIdsFor(index: number): string[] {
  return Array.from(
    { length: 2 + (index % 2) },
    (_, position) => `combined-${digest(index, position)}`
  )
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
export const SCENARIOS = scenarioData as readonly Scenario[]
const iso = (milliseconds: number): string =>
  new Date(milliseconds).toISOString()
/**
 * Deterministic pseudo-random ids in the shape Review Runs actually assigns
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

function sourceFor(index: number): {
  platform: FixtureSourcePlatform
  connectorId: string
} {
  if (index % 17 === 0)
    return { platform: 'unknown', connectorId: 'legacy-webhook:default' }
  if (index % 5 === 0)
    return { platform: 'gitlab', connectorId: 'gitlab-integration:default' }
  return { platform: 'github', connectorId: 'github-integration:default' }
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
    message: 'The Execution API reported no diagnostic bundle.'
  }
}

/**
 * A coherent coordination history for one fixture run, derived from its current state so the
 * console's History section has something truthful to show without a backend. The order and
 * axes mirror what Review Runs writes: execution and preparation start at admission,
 * publication starts once execution succeeds.
 */
export function eventsFor(run: FixtureRun): Array<{
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
    // An unresolved submission never reached `queued`: Review Runs moves `pending` straight to
    // `uncertain` when the Execution Gateway call's acceptance could not be confirmed. The recovery then
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
    // The Execution Gateway was never called: execution was skipped because preparation failed, so no
    // failure reason rides on the execution axis.
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
 * Rejects any generated run that Review Runs could never produce. The
 * checks mirror the store's write paths: publication only starts after a
 * succeeded execution, every terminal failure marks the publication
 * `skipped` in the same transaction, and the diagnostic artifact is
 * reported only when the execution is terminal.
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

export const runs: FixtureRun[] = Array.from(
  { length: RUN_COUNT },
  (_, index) => {
    const scenario = SCENARIOS[index % SCENARIOS.length]!
    // Rotate the workflow offset as scenarios advance, so every (scenario, workflow) pair occurs
    // regardless of how many scenarios there are. A plain `index % len` freezes the pairing when
    // the two lengths share a factor, which silently dropped some combinations from the fixtures.
    const workflow =
      WORKFLOWS[
        (index + Math.floor(index / WORKFLOWS.length)) % WORKFLOWS.length
      ]!
    const run_id = runId(index)
    const source = sourceFor(index)
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
    const executionStartedAt =
      createdAt + Math.min(scenario.executionMs, 60_000)
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
      connector_id: source.connectorId,
      source_platform: source.platform,
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
      execution_statistics:
        scenario.execution_status === 'succeeded'
          ? executionStatisticsFor(
              workflow,
              executionUpdatedAt,
              workflow === 'repository-review' || index % 2 === 0,
              index
            )
          : null,
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
      // than Review Runs produces.
      notices: noticesFor(
        scenario,
        preparation,
        execution,
        scenario.publication_status
      )
    }
  }
)

// The operator queue, shaped exactly as coordination would leave it. `EXECUTION_ALREADY_ADVANCED`
// means an expired preparation lease could not be concluded because execution had already moved
// past `pending`: writing "the Execution Gateway never ran" would overwrite a real result. So the two runs
// below are put into that contradictory state - preparation still `preparing`, execution advanced,
// publication still waiting - rather than just being labelled with the code. A marker on a run
// whose axes are consistent would teach the console a state Review Runs cannot produce.
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
export const stepsByRun = new Map<string, FixtureStep[]>(
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
export const parkedIndexes = new Set<number>()
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

export function decodeCursor(value: string | null): Cursor | null {
  if (value === null) return null
  const [createdAt, runId, extra] = Buffer.from(value, 'base64url')
    .toString('utf8')
    .split('|')
  if (createdAt === undefined || runId === undefined || extra !== undefined)
    return null
  return { createdAt, runId }
}
