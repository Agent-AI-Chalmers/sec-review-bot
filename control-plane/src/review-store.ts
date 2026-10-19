// Implements Control Plane's durable review trunk and its read projection, and orchestrates
// the cross-axis transitions that must move more than one lifecycle axis in one transaction.
//
// Axis ownership:
// - `execution-store.ts` owns single-axis execution writes (status transitions, observation
//   heartbeat, artifact/result, submission-recovery claims).
// - `preparation-store.ts` / `publication-store.ts` own their own axes.
// - This store owns the run trunk, the full-record projection (`RUN_SELECT`/`rowToRecord`),
//   and cross-axis transitions (submit -> queued, execution failure -> publication skipped,
//   rejected replay -> publication skipped). A cross-axis transition is owned by the axis that
//   initiates it; preparations initiating an execution skip is therefore in that store.
// - `publication-abandon.ts` holds the one transition shared by more than one axis: concluding a
//   publication that can never publish. It is separate because both preparation and execution
//   trigger it, and single-axis stores must not import each other (this store is what constructs
//   them). It is still a cross-axis write, kept atomic by taking the caller's transaction.
//
// Publication has no reversion into it: an uncertain submission leaves publication `pending`
// rather than skipping it, so neither an accepted nor a rejected replay has a publication
// transition to undo.
// Claim tokens here are the sole fencing authority for writes.
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

import type {
  ControlPlaneWorkflow as WorkflowName,
  RunnerArtifactStorage
} from './contracts.js'
import {
  applySchemaVersions,
  KNOWN_SCHEMA_VERSIONS
} from './database/schema-version-runner.js'
import {
  normalizeArtifactStorage,
  type CreateReviewRunArgs,
  type PublicationStatus,
  type ObservedRun,
  type PublicationStepRecord,
  type PreparationStatus,
  type PublicationWork,
  type ReviewRunAdmission,
  type ReviewRunEvent,
  type ReviewRunRecord,
  type RunnerStatus
} from './shapes.js'
import {
  PreparationStore,
  type PreparationExpiryBlocked,
  type PreparationExpiryResult,
  type RunFailureNoticeWork,
  type PreparationWork
} from './preparation-store.js'
import { PublicationStore } from './publication-store.js'
import { abandonInFlightPublication } from './publication-abandon.js'
import { appendEvent, listEvents } from './review-run-events.js'
import { ExecutionStore } from './execution-store.js'

export type {
  CreateReviewRunArgs,
  PreparationStatus,
  PublicationStatus,
  PublicationStepRecord,
  PublicationWork,
  ReviewRunAdmission,
  ReviewRunRecord,
  RunnerStatus
} from './shapes.js'

type JsonObject = Record<string, unknown>
export type PublishContext = JsonObject

export type {
  PreparationExpiryBlocked,
  PreparationExpiryResult,
  RunFailureNoticeWork,
  PreparationWork
} from './preparation-store.js'

/** One axis' columns as the SELECT returns them, before they are shaped for the record.
 *
 * The axes share a shape on purpose: `status`, `started_at`, `finished_at`, `updated_at`, and the
 * failure pair mean the same thing on each. Grouping them here is what lets the type say which
 * axis a timestamp belongs to, instead of a flat bag where `started_at` and
 * `execution_finished_at` sit side by side with no way to tell whether the prefix matters. */
interface AxisRowColumns<S> {
  status: S
  started_at: string | null
  finished_at: string | null
  updated_at: string | null
  failure_code: string | null
  failure_message: string | null
}

/** The row `RUN_SELECT` produces: the run trunk, its three axes, and the notice outbox.
 *
 * `executions` and `preparations` are LEFT JOINed, so their axes carry a `missing` flag rather
 * than being nullable: a run with a missing axis row is corruption the projection must report,
 * and a null axis would force every caller to re-decide what a missing axis means. `publications`
 * is an inner join, so it has no such flag. */
interface ReviewRunRow {
  trunk: {
    run_id: string
    workflow: WorkflowName
    publish_context: JsonObject
    created_at: string
    created_at_cursor: string
    ingress_kind: 'github_webhook' | 'github_actions_dispatch' | null
    ingress_key: string | null
  }
  execution: AxisRowColumns<RunnerStatus> & {
    missing: boolean
    input: JsonObject | null
    observed_at: string | null
    artifact_storage: RunnerArtifactStorage | null
    workflow_result: unknown | null
  }
  publication: AxisRowColumns<PublicationStatus>
  preparation: AxisRowColumns<
    'pending' | 'preparing' | 'submitted' | 'failed' | null
  > & {
    missing: boolean
    attempt_count: number | null
    expiry_blocked_reason: string | null
  }
  /** Written on any axis' terminal failure; `status` is null when no notice exists.
   *
   * Taken from the read contract rather than restated, so a state added to the notice machine
   * (or one renamed, as `skipped` became `failed`) cannot leave this row type behind. */
  failure_notice: {
    status: NonNullable<ObservedRun['failure_notice']>['status'] | null
    failure_stage:
      NonNullable<ObservedRun['failure_notice']>['failure_stage'] | null
    failure_code: string | null
    comment_url: string | null
  }
}

const DEFAULT_CLAIM_TIMEOUT_MS = 10 * 60 * 1000
/** How often a waiting publication claim re-checks for work. The state is a local indexed
 * query, so this trades a cheap read against how quickly the caller starts publishing. */
const CLAIM_WAIT_INTERVAL_MS = 250

/**
 * The full cross-axis read: one run trunk row joined to its three axis rows.
 *
 * `created_at_cursor` carries the full-precision (microsecond) UTC timestamp for keyset
 * pagination. node-pg maps `created_at` to a millisecond JS Date, so a cursor built from the
 * truncated value would skip every row in the same millisecond; this string keeps the
 * microseconds for an exact `(created_at, run_id) < boundary`.
 *
 * `executions`, `preparations`, and the failure notice are LEFT JOINed so a run that somehow
 * lacks one of those rows is surfaced and reported by the projection, not silently dropped from
 * every read. `publications` is an inner join because publication is never optional.
 */
const RUN_SELECT = `
  SELECT
    json_build_object(
      'run_id', r.run_id,
      'workflow', r.workflow,
      'publish_context', p.input,
      'created_at', r.created_at,
      'created_at_cursor', to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'ingress_kind', r.ingress_kind,
      'ingress_key', r.ingress_key
    ) AS trunk,
    json_build_object(
      'status', e.status,
      'started_at', e.started_at,
      'finished_at', e.finished_at,
      'updated_at', e.observed_at,
      'failure_code', e.failure_code,
      'failure_message', e.failure_message,
      'missing', (e.run_id IS NULL),
      'input', e.input,
      'observed_at', e.observed_at,
      'artifact_storage', e.artifact_storage,
      'workflow_result', e.workflow_result
    ) AS execution,
    json_build_object(
      'status', p.status,
      'started_at', p.started_at,
      'finished_at', p.finished_at,
      'updated_at', p.updated_at,
      'failure_code', p.failure_code,
      'failure_message', p.failure_message
    ) AS publication,
    json_build_object(
      'status', pr.status,
      'started_at', pr.started_at,
      'finished_at', pr.finished_at,
      'updated_at', pr.updated_at,
      'failure_code', pr.failure_code,
      'failure_message', pr.failure_message,
      'missing', (pr.run_id IS NULL),
      'attempt_count', pr.attempt_count,
      'expiry_blocked_reason', pr.expiry_blocked_reason
    ) AS preparation,
    -- The notice belongs to the run, not to any one axis: an execution or publication failure
    -- queues one too, so projecting it through the preparation object would have hidden
    -- two thirds of them.
    json_build_object(
      'status', n.status,
      'failure_stage', n.failure_stage,
      'failure_code', n.failure_code,
      'comment_url', n.comment_url
    ) AS failure_notice
  FROM review_runs r
  JOIN publications p ON p.run_id = r.run_id AND p.connector_id = r.connector_id
  LEFT JOIN executions e ON e.run_id = r.run_id AND e.connector_id = r.connector_id
  LEFT JOIN preparations pr
    ON pr.run_id = r.run_id AND pr.connector_id = r.connector_id
  LEFT JOIN run_failure_notices n
    ON n.run_id = r.run_id AND n.connector_id = r.connector_id
`

/** Normalize a timestamp the SELECT produced. `json_build_object` serializes timestamptz as an
 * ISO string, so this only ever narrows the precision (microseconds to milliseconds) - it never
 * receives a `Date`. Values come from `clock_timestamp()`, so parsing is exact. */
function iso(value: string): string {
  return new Date(value).toISOString()
}
/** `iso` for an axis timestamp that is meaningful only once the phase reaches it. */
function isoOrNull(value: string | null): string | null {
  return value === null ? null : iso(value)
}
function rowToRecord(row: ReviewRunRow): ReviewRunRecord {
  const { trunk, execution, publication, preparation } = row
  if (execution.missing) {
    // A run without its execution row is corrupt, not a valid record. Throwing makes the
    // projection report it in `dropped` instead of silently omitting or misrepresenting it.
    throw new Error(`run ${trunk.run_id} has no executions row`)
  }
  if (preparation.missing) {
    // Same rule as the execution axis: admission writes the run, its preparation, and its
    // execution in one transaction and nothing deletes an axis alone, so a missing preparation
    // row is corruption. Returning `preparation: null` would report it as a legitimate record,
    // which is exactly what the contract says null does *not* mean.
    throw new Error(`run ${trunk.run_id} has no preparations row`)
  }
  // The guard above proves the row exists, but the axis columns are still typed nullable because
  // the query LEFT JOINs them. Narrowing with real checks (rather than `as`) keeps the type
  // honest if a future column is added to the summary without a matching NOT NULL in the schema.
  if (preparation.status === null || preparation.attempt_count === null) {
    throw new Error(`run ${trunk.run_id} has an incomplete preparations row`)
  }
  if (
    execution.observed_at === null ||
    preparation.updated_at === null ||
    publication.updated_at === null
  ) {
    // These three are NOT NULL in the schema, so a null here can only mean the LEFT JOIN was
    // somehow satisfied by a partial row. Checking rather than asserting keeps the type honest.
    throw new Error(`run ${trunk.run_id} has an incomplete axis row`)
  }
  // The run-level failure code names the axis that actually stopped the run, in the order the
  // phases run:
  // - a `failed` publication is the terminal failure: report its own code, even when that code
  //   is null. Falling back to the execution/preparation code here would attribute another
  //   axis' reason to the publication that genuinely failed.
  // - otherwise execution is next, then preparation. A skipped execution still reports the
  //   preparation failure that caused it, and a publication skipped because execution failed
  //   reports that execution reason, because publication itself never failed.
  const publicationFailure = publication.status === 'failed'
  return {
    run_id: trunk.run_id,
    workflow: trunk.workflow,
    publish_context: trunk.publish_context,
    ...(execution.input === null ? {} : { runner_input: execution.input }),
    preparation: {
      status: preparation.status,
      attempt_count: preparation.attempt_count,
      started_at: isoOrNull(preparation.started_at),
      finished_at: isoOrNull(preparation.finished_at),
      updated_at: iso(preparation.updated_at),
      failure_code: preparation.failure_code,
      // Non-null means coordination stopped retrying this run: the persisted story contradicts
      // an expiry conclusion, so it needs an operator decision. Exposed here so the condition is
      // visible on the read surface instead of only in a log line.
      expiry_blocked_reason: preparation.expiry_blocked_reason
    },
    // Each axis reports the same three instants under the same names: when it started, when it
    // finished, and (for execution) when it was last observed.
    execution: {
      status: execution.status,
      started_at: isoOrNull(execution.started_at),
      finished_at: isoOrNull(execution.finished_at),
      updated_at: iso(execution.observed_at)
    },
    publication: {
      status: publication.status,
      started_at: isoOrNull(publication.started_at),
      finished_at: isoOrNull(publication.finished_at),
      updated_at: iso(publication.updated_at)
    },
    created_at: iso(trunk.created_at),
    failure_code: publicationFailure
      ? publication.failure_code
      : (execution.failure_code ?? preparation.failure_code),
    failure_message: publicationFailure
      ? publication.failure_message
      : (execution.failure_message ?? preparation.failure_message),
    artifact_storage: normalizeArtifactStorage(
      execution.artifact_storage,
      `run ${trunk.run_id}`
    ),
    // Always present, null when no notice exists: the read contract requires the field, so a
    // consumer never has to distinguish "never failed" from "the server forgot to send it".
    failure_notice:
      row.failure_notice.status === null
        ? null
        : {
            // The stage is NOT NULL whenever a notice row exists, so the fallback only covers a
            // projection the join could not fill, which cannot happen for a present row.
            status: row.failure_notice.status,
            failure_stage: row.failure_notice.failure_stage ?? 'preparation',
            failure_code: row.failure_notice.failure_code,
            comment_url: row.failure_notice.comment_url
          },
    ...(trunk.ingress_kind ? { ingress_kind: trunk.ingress_kind } : {}),
    ...(trunk.ingress_key ? { ingress_key: trunk.ingress_key } : {})
  }
}

/** A stored row the contract cannot represent, kept so a fan-out read can report it. */
export interface DroppedRunRow {
  run_id: string
  error: unknown
}

/** A fan-out read's result: the rows that project cleanly, and the ones that do not.
 *
 * `rowToRecord` can throw (a stored shape the contract forbids, such as an `available`
 * artifact without its reference). Applying it with `.map` over a result set turns one bad
 * row into a failed read of *every* row, which for the coordinator's polling reads means the
 * whole pass stops and no run is observed. Returning the failures alongside the records lets
 * the caller keep making progress and still report each dropped row with its identity. */
export interface RunRowsProjection {
  runs: ReviewRunRecord[]
  dropped: DroppedRunRow[]
}

function projectRunRows(rows: ReviewRunRow[]): RunRowsProjection {
  const runs: ReviewRunRecord[] = []
  const dropped: DroppedRunRow[] = []
  for (const row of rows) {
    try {
      runs.push(rowToRecord(row))
    } catch (error) {
      dropped.push({ run_id: row.trunk.run_id, error })
    }
  }
  return { runs, dropped }
}
async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export class ReviewRunStore {
  private readonly pool: Pool
  readonly connectorId: string
  private readonly claimTimeoutMs: number
  private readonly preparations: PreparationStore
  private readonly publications: PublicationStore
  private readonly executions: ExecutionStore
  private readonly onDroppedRunRow: (dropped: DroppedRunRow) => void
  private initialized = false

  constructor({
    connectionString,
    connectorId = process.env.CONNECTOR_ID?.trim() || 'github-app:default',
    claimTimeoutMs = DEFAULT_CLAIM_TIMEOUT_MS,
    pool,
    onDroppedRunRow = () => {}
  }: {
    connectionString?: string
    connectorId?: string
    claimTimeoutMs?: number
    pool?: Pool
    /** Reports a stored row the record contract cannot represent. Fan-out reads already return
     * those in `dropped` for the caller to report; this covers the single-run read, which has no
     * such list and would otherwise discard the fault silently. */
    onDroppedRunRow?: (dropped: DroppedRunRow) => void
  } = {}) {
    this.onDroppedRunRow = onDroppedRunRow
    this.pool = pool ?? new Pool({ connectionString })
    this.connectorId = connectorId
    this.claimTimeoutMs = Math.max(0, claimTimeoutMs)
    this.preparations = new PreparationStore(
      this.pool,
      this.connectorId,
      this.claimTimeoutMs
    )
    this.publications = new PublicationStore(
      this.pool,
      this.connectorId,
      this.claimTimeoutMs
    )
    this.executions = new ExecutionStore(
      this.pool,
      this.connectorId,
      this.claimTimeoutMs
    )
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await applySchemaVersions(this.pool)
    this.initialized = true
  }

  /** Verify the dependency boundary required to accept coordination requests. */
  async checkReadiness(): Promise<void> {
    this.ready()
    const result = await this.pool.query<{ version: number }>(
      'SELECT version FROM schema_versions ORDER BY version'
    )
    const appliedVersions = result.rows.map(({ version }) => version)
    if (
      appliedVersions.length !== KNOWN_SCHEMA_VERSIONS.length ||
      appliedVersions.some(
        (version, index) => version !== KNOWN_SCHEMA_VERSIONS[index]
      )
    ) {
      throw new Error('Control Plane schema ledger is not current.')
    }
  }

  private ready(): void {
    if (!this.initialized)
      throw new Error('ReviewRunStore.initialize() must complete before use.')
  }

  private async getWith(
    client: PoolClient,
    runId: string
  ): Promise<ReviewRunRecord | null> {
    const result = await client.query<ReviewRunRow>(
      `${RUN_SELECT}
      WHERE r.run_id=$1 AND r.connector_id=$2`,
      [runId, this.connectorId]
    )
    return result.rows[0] === undefined ? null : rowToRecord(result.rows[0])
  }
  private async insertWith(
    client: PoolClient,
    run: CreateReviewRunArgs
  ): Promise<ReviewRunAdmission> {
    const preparationToken = crypto.randomUUID()
    await client.query(
      `INSERT INTO review_runs
      (run_id,connector_id,workflow,ingress_kind,ingress_key)
      VALUES ($1,$2,$3,$4,$5)`,
      [
        run.run_id,
        this.connectorId,
        run.workflow,
        run.ingress_kind ?? null,
        run.ingress_key ?? null
      ]
    )
    await client.query(
      `INSERT INTO executions
        (run_id,connector_id,status,input)
       VALUES ($1,$2,'pending',$3::jsonb)`,
      [
        run.run_id,
        this.connectorId,
        run.runner_input === undefined ? null : JSON.stringify(run.runner_input)
      ]
    )
    // Admission itself takes the first preparation claim, so the preparation phase starts here
    // as well as in `claimNext`: a run admitted and prepared in one request must not show a null
    // start just because it never went back through the pending queue.
    await client.query(
      `INSERT INTO preparations
        (run_id,connector_id,input_version,input,status,claim_token,claimed_at,attempt_count,started_at)
       VALUES ($1,$2,$3,$4::jsonb,'preparing',$5,clock_timestamp(),1,clock_timestamp())`,
      [
        run.run_id,
        this.connectorId,
        run.preparation_input_version ?? 'direct-v1',
        JSON.stringify(run.preparation_input ?? {}),
        preparationToken
      ]
    )
    await client.query(
      `
      INSERT INTO publications (run_id,connector_id,input,status)
      VALUES ($1,$2,$3::jsonb,'pending')
    `,
      [run.run_id, this.connectorId, JSON.stringify(run.publish_context)]
    )
    // Admission is the first transition on both axes: the runner starts `pending` (input not
    // yet submitted) and a preparation row is created already owned by this admission's claim.
    await appendEvent(client, {
      runId: run.run_id,
      connectorId: this.connectorId,
      axis: 'execution',
      fromStatus: null,
      toStatus: 'pending'
    })
    await appendEvent(client, {
      runId: run.run_id,
      connectorId: this.connectorId,
      axis: 'preparation',
      fromStatus: null,
      toStatus: 'preparing'
    })
    await appendEvent(client, {
      runId: run.run_id,
      connectorId: this.connectorId,
      axis: 'publication',
      fromStatus: null,
      toStatus: 'pending'
    })
    const record = await this.getWith(client, run.run_id)
    if (record === null)
      throw new Error(`Runner run was not persisted: ${run.run_id}`)
    return { record, created: true, preparation_token: preparationToken }
  }
  async createPreparingReviewRun(
    run: CreateReviewRunArgs
  ): Promise<ReviewRunAdmission> {
    this.ready()
    return await transaction(
      this.pool,
      async (client) => await this.insertWith(client, run)
    )
  }
  async admitReviewRun(
    run: CreateReviewRunArgs &
      Required<Pick<CreateReviewRunArgs, 'ingress_kind' | 'ingress_key'>>
  ): Promise<ReviewRunAdmission> {
    this.ready()
    try {
      return await transaction(this.pool, async (client) => {
        const existing = await client.query<ReviewRunRow>(
          `${RUN_SELECT}
          WHERE r.connector_id=$1 AND r.ingress_kind=$2 AND r.ingress_key=$3
          FOR UPDATE OF r`,
          [this.connectorId, run.ingress_kind, run.ingress_key]
        )
        const row = existing.rows[0]
        if (row === undefined) return await this.insertWith(client, run)
        // Ingress replay is an idempotent read. The preparation coordinator is
        // the sole owner of post-admission claims, including lease recovery.
        return {
          record: rowToRecord(row),
          created: false,
          preparation_token: null
        }
      })
    } catch (error: unknown) {
      if (!(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ))
        throw error
      // A concurrent transaction won the ingress identity. Read its durable run
      // after PostgreSQL rolls back this transaction.
      const existing = await this.pool.query<ReviewRunRow>(
        `${RUN_SELECT}
        WHERE r.connector_id=$1 AND r.ingress_kind=$2 AND r.ingress_key=$3`,
        [this.connectorId, run.ingress_kind, run.ingress_key]
      )
      if (existing.rows[0] === undefined) {
        // The unique violation came from a concurrent admission that is not visible afterwards,
        // which means it rolled back. Re-throwing the raw 23505 would report a database
        // constraint to a caller that asked for an idempotent admission, so say what happened.
        throw new Error(
          `ingress replay for ${run.ingress_kind}:${run.ingress_key} lost a concurrent ` +
            `admission that rolled back; the request can be retried`,
          { cause: error }
        )
      }
      return {
        record: rowToRecord(existing.rows[0]),
        created: false,
        preparation_token: null
      }
    }
  }
  async savePreparedSubmission(
    runId: string,
    token: string,
    context: PublishContext,
    input: JsonObject
  ): Promise<void> {
    // Both axes are written by one statement, but a single statement is not a transaction here:
    // every data-modifying CTE runs, and the trailing `SELECT ... WHERE EXISTS` only decides how
    // many rows are returned. So when the execution arm matches nothing, the publication arm has
    // already changed `publications.input`, and checking `rowCount` on a bare `pool.query` would
    // throw after that half-write had auto-committed. Wrapping the statement lets the same check
    // roll the publication back, keeping the two axes atomic like every other cross-axis write.
    await transaction(this.pool, async (client) => {
      // Read the workflow inside the transaction, not before it: the value feeds a predicate the
      // writes below depend on, and a read outside would be a separate snapshot from the one that
      // decides whether they match.
      const run = await this.getWith(client, runId)
      if (run === null) throw new Error(`Review run does not exist: ${runId}`)
      const result = await client.query(
        `
      WITH updated_publication AS (
        UPDATE publications
        SET input=$3::jsonb, updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$5
          AND EXISTS (
            SELECT 1 FROM review_runs r
            WHERE r.run_id=publications.run_id AND r.connector_id=$5 AND r.workflow=$6
          )
        RETURNING run_id
      ),
      updated_execution AS (
        UPDATE executions
        SET input=$4::jsonb, updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$5
          AND status='pending' AND EXISTS (
            SELECT 1 FROM preparations
            WHERE preparations.run_id=executions.run_id
              AND preparations.connector_id=$5 AND preparations.status='preparing'
              AND preparations.claim_token=$2
          )
        RETURNING run_id
      )
      SELECT run_id FROM updated_execution
      WHERE EXISTS (SELECT 1 FROM updated_publication)
    `,
        [
          runId,
          token,
          JSON.stringify(context),
          JSON.stringify(input),
          this.connectorId,
          run.workflow
        ]
      )
      if (result.rowCount !== 1)
        throw new Error(
          `Review run ${runId} cannot save prepared submission outside pending.`
        )
    })
  }
  async renewPreparationClaim(runId: string, token: string): Promise<boolean> {
    this.ready()
    return await this.preparations.renewClaim(runId, token)
  }
  async claimNextPreparation(): Promise<PreparationWork | null> {
    this.ready()
    return await this.preparations.claimNext()
  }
  async checkpointPreparationInput(
    runId: string,
    token: string,
    input: JsonObject
  ): Promise<void> {
    this.ready()
    await this.preparations.checkpointInput(runId, token, input)
  }
  async claimNextRunFailureNotice(): Promise<RunFailureNoticeWork | null> {
    this.ready()
    return await this.preparations.claimNextFailureNotice()
  }
  async completeRunFailureNotice(
    runId: string,
    token: string,
    delivered: boolean,
    commentUrl?: string | null
  ): Promise<boolean> {
    this.ready()
    return await this.preparations.completeFailureNotice(
      runId,
      token,
      delivered,
      commentUrl
    )
  }
  preparationHeartbeatIntervalMs(): number {
    return this.preparations.heartbeatIntervalMs()
  }
  async markQueued(
    runId: string,
    token: string,
    context: PublishContext
  ): Promise<void> {
    return await transaction(this.pool, async (client) => {
      const run = await this.getWith(client, runId)
      if (run === null)
        // The run id came from the caller, so a missing run is a 4xx, not a server fault.
        // Without `statusCode` the HTTP layer would report it as 500 and hide the real cause.
        throw Object.assign(new Error(`Review run does not exist: ${runId}`), {
          statusCode: 404
        })
      // Submitting the prepared input asserts the same premise a replay does: the publication is
      // still pending, because the run may now succeed and its result must remain deliverable.
      // Without the status check this row would accept the new input even after another path had
      // concluded the publication, and the execution below would then queue a run whose result
      // can never be published. Matching no row fails the whole transaction.
      const result = await client.query(
        `
        UPDATE publications
        SET input=$2::jsonb, updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$3
          AND status='pending'
          AND EXISTS (
            SELECT 1 FROM review_runs r
            WHERE r.run_id=publications.run_id AND r.connector_id=$3 AND r.workflow=$4
          )
      `,
        [runId, JSON.stringify(context), this.connectorId, run.workflow]
      )
      const queued = await client.query(
        `
        UPDATE executions
        SET status='queued', started_at=COALESCE(started_at, clock_timestamp()),
            failure_code=NULL, failure_message=NULL,
            observed_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$3
          AND status='pending' AND EXISTS (
            SELECT 1 FROM preparations
            WHERE preparations.run_id=executions.run_id
              AND preparations.connector_id=$3 AND preparations.status='preparing'
              AND preparations.claim_token=$2
          )
      `,
        [runId, token, this.connectorId]
      )
      if (result.rowCount !== 1 || queued.rowCount !== 1)
        throw new Error(
          `Review run ${runId} cannot transition from pending to queued.`
        )
      const completed = await client.query(
        `UPDATE preparations
         SET status='submitted', claim_token=NULL, claimed_at=NULL,
             finished_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='preparing'
           AND claim_token=$3`,
        [runId, this.connectorId, token]
      )
      if (completed.rowCount !== 1)
        throw new Error(
          `Preparation ${runId} lost its claim before the queued transition completed.`
        )
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'execution',
        fromStatus: 'pending',
        toStatus: 'queued'
      })
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'preparation',
        fromStatus: 'preparing',
        toStatus: 'submitted'
      })
    })
  }
  /** Whether this connector owns a run trunk row with this id.
   *
   * The event log lives on the trunk, so answering "does this run exist?" must not go through the
   * full record projection: that projection treats an unrepresentable axis row as a corrupt run
   * and returns `null`, which would make the events endpoint answer 404 for a run whose history
   * is in fact readable. */
  async runExists(runId: string): Promise<boolean> {
    this.ready()
    const result = await this.pool.query(
      'SELECT 1 FROM review_runs WHERE run_id=$1 AND connector_id=$2',
      [runId, this.connectorId]
    )
    return result.rowCount === 1
  }
  async listEvents(runId: string): Promise<ReviewRunEvent[]> {
    this.ready()
    return await listEvents(this.pool, runId, this.connectorId)
  }
  async getRun(runId: string): Promise<ReviewRunRecord | null> {
    this.ready()
    const result = await this.pool.query<ReviewRunRow>(
      `${RUN_SELECT}
      WHERE r.run_id=$1 AND r.connector_id=$2`,
      [runId, this.connectorId]
    )
    const row = result.rows[0]
    if (row === undefined) return null
    // A row the record contract cannot represent (e.g. a run missing one of its axis rows) is
    // treated as absent, matching the list projection that reports it in `dropped`. Unlike a
    // genuinely unknown run id, this is corruption, so it is reported before being hidden
    // behind the same `null`.
    try {
      return rowToRecord(row)
    } catch (error) {
      this.onDroppedRunRow({ run_id: row.trunk.run_id, error })
      return null
    }
  }

  private async listRunRows(
    options: {
      limit?: number
      cursor?: string
      execution_status?: RunnerStatus
      publication_status?: PublicationStatus
      preparation_status?: PreparationStatus
      workflow?: WorkflowName
      from?: string
      to?: string
    },
    limit: number
  ): Promise<ReviewRunRow[]> {
    this.ready()
    const values: unknown[] = [this.connectorId]
    const clauses = ['r.connector_id=$1']
    const add = (value: unknown): string => {
      values.push(value)
      return `$${values.length}`
    }
    if (options.workflow !== undefined)
      clauses.push(`r.workflow=${add(options.workflow)}`)
    // An axis filter selects on that axis' state, but must not hide a row whose axis is missing:
    // such a row is corrupt, and the projection reports it in `dropped`. Filtering it out here
    // instead would make the filter the only reason corruption went unnoticed.
    if (options.execution_status !== undefined) {
      const status = add(options.execution_status)
      clauses.push(`(e.status=${status} OR e.run_id IS NULL)`)
    }
    if (options.publication_status !== undefined) {
      // Publication is an inner join, so a "missing" publication row means the whole row is
      // absent from the read; only the LEFT JOINed axes can be reported this way.
      clauses.push(`p.status=${add(options.publication_status)}`)
    }
    if (options.preparation_status !== undefined) {
      const status = add(options.preparation_status)
      clauses.push(`(pr.status=${status} OR pr.run_id IS NULL)`)
    }
    if (options.from !== undefined)
      clauses.push(`r.created_at>=${add(options.from)}`)
    if (options.to !== undefined)
      clauses.push(`r.created_at<${add(options.to)}`)
    if (options.cursor !== undefined) {
      const [createdAt, runId] = Buffer.from(options.cursor, 'base64url')
        .toString('utf8')
        .split('|')
      if (!createdAt || !runId) throw new Error('Invalid run list cursor.')
      clauses.push(
        `(r.created_at, r.run_id)<(${add(createdAt)}, ${add(runId)})`
      )
    }
    const result = await this.pool.query<ReviewRunRow>(
      `${RUN_SELECT}
      WHERE ${clauses.join(' AND ')} ORDER BY r.created_at DESC, r.run_id DESC LIMIT ${add(limit)}`,
      values
    )
    return result.rows
  }

  /** Page of records plus a keyset cursor, for the HTTP list endpoint.
   *
   * Two cursor bugs are fixed together here:
   * - The cursor carries `created_at_cursor` (microseconds). The public record's
   *   `created_at` is a millisecond JS Date, so a cursor built from it skipped every
   *   row sharing the cursor's millisecond.
   * - It peeks `limit + 1` rows and emits a cursor only when the extra row exists, so
   *   a full final page no longer hands out a cursor that strands the reader on an
   *   empty page.
   *
   * A row the contract cannot represent is returned in `dropped` rather than aborting the
   * page, so one corrupt row does not turn a listing into a 500. The cursor is still taken
   * from the raw boundary row, so a dropped row is skipped once instead of stranding the
   * reader on it. */

  async listRunsPage(
    options: {
      limit?: number
      cursor?: string
      execution_status?: RunnerStatus
      publication_status?: PublicationStatus
      preparation_status?: PreparationStatus
      workflow?: WorkflowName
      from?: string
      to?: string
    } = {}
  ): Promise<{
    runs: ReviewRunRecord[]
    next_cursor: string | null
    dropped: DroppedRunRow[]
  }> {
    const boundedLimit = Math.min(
      Math.max(Math.trunc(options.limit ?? 50), 1),
      100
    )
    const rows = await this.listRunRows(options, boundedLimit + 1)
    const hasMore = rows.length > boundedLimit
    const page = rows.slice(0, boundedLimit)
    const last = page.at(-1)
    const next_cursor =
      hasMore && last !== undefined
        ? Buffer.from(
            `${last.trunk.created_at_cursor}|${last.trunk.run_id}`
          ).toString('base64url')
        : null
    const { runs, dropped } = projectRunRows(page)
    return { runs, next_cursor, dropped }
  }
  async expireStalePreparations(): Promise<PreparationExpiryResult> {
    this.ready()
    return await this.preparations.expireStale()
  }
  /** List the runs coordination has stopped retrying, because their persisted story
   * contradicts an expiry conclusion. These are the rows an operator has to decide about; the
   * read exists so that decision can start from the API instead of from a log search. */
  async listBlockedPreparationExpiries(): Promise<PreparationExpiryBlocked[]> {
    this.ready()
    const result = await this.pool.query<{
      run_id: string
      reason: PreparationExpiryBlocked['reason']
    }>(
      `SELECT run_id, expiry_blocked_reason AS reason FROM preparations
       WHERE connector_id=$1 AND expiry_blocked_reason IS NOT NULL
       ORDER BY expiry_blocked_at, run_id`,
      [this.connectorId]
    )
    return result.rows
  }

  /** Abandon a blocked run at an operator's explicit request.
   *
   * This is not a repair and does not try to make the run publishable: it concludes the axes
   * that are still open, so the run stops holding work no coordinator can conclude. The
   * execution axis is deliberately left exactly as it is - a `succeeded` result and its
   * `workflow_result` stay on the row - because abandoning says "this result will not be
   * delivered", not "this result never happened". Nothing is deleted: the run, its events, and
   * its ingress identity all remain, so a replay of the same webhook still resolves to this run
   * instead of starting a new one.
   *
   * Only a blocked preparation is eligible. That restriction is what keeps this from becoming a
   * general state-jumping endpoint: it can only finish a transition coordination already proved
   * impossible.
   *
   * `reason` is required and recorded on every event, so an abandonment always names why. */
  async abandonBlockedPreparation(
    runId: string,
    reason: string
  ): Promise<ReviewRunRecord> {
    this.ready()
    if (reason.trim() === '')
      throw Object.assign(new Error('An abandonment reason is required.'), {
        statusCode: 400
      })
    return await transaction(this.pool, async (client) => {
      // Claim the decision: only one caller may abandon a given blocked row, and the block
      // marker doubles as the "still needs a decision" flag.
      const blocked = await client.query<{ attempt_count: number }>(
        `SELECT attempt_count FROM preparations
         WHERE run_id=$1 AND connector_id=$2
           AND expiry_blocked_reason IS NOT NULL
         FOR UPDATE`,
        [runId, this.connectorId]
      )
      if (blocked.rowCount !== 1)
        throw Object.assign(
          new Error(`Review run ${runId} is not a blocked preparation.`),
          { statusCode: 409 }
        )

      const failed = await client.query(
        `UPDATE preparations
         SET status='failed', claim_token=NULL, claimed_at=NULL,
             failure_code='PREPARATION_ABANDONED',
             failure_message=$3,
             last_failure_code='PREPARATION_ABANDONED',
             last_failure_message=$3,
             finished_at=clock_timestamp(),
             expiry_blocked_reason=NULL, expiry_blocked_at=NULL,
             updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='preparing'`,
        [runId, this.connectorId, reason]
      )
      if (failed.rowCount !== 1)
        throw new Error(
          `Preparation ${runId} changed while being abandoned; nothing was written.`
        )
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'preparation',
        fromStatus: 'preparing',
        toStatus: 'failed',
        reasonCode: 'PREPARATION_ABANDONED'
      })
      // A blocked run never queued a notice: its expiry was refused before reaching the code
      // that does, which is why it needed an operator at all. The decision ends the run, so the
      // requester has to hear about it; `DO NOTHING` leaves an earlier notice untouched.
      await client.query(
        `INSERT INTO run_failure_notices (run_id,connector_id,status,failure_stage,failure_code)
         VALUES ($1,$2,'pending','preparation','PREPARATION_ABANDONED')
         ON CONFLICT (run_id) DO NOTHING`,
        [runId, this.connectorId]
      )
      // Any publication still waiting is not applicable now that the run will not deliver a
      // result. The helper reports what it actually moved, so the event names the real origin.
      const publicationFrom = await abandonInFlightPublication(
        client,
        this.connectorId,
        runId
      )
      if (publicationFrom !== null) {
        await appendEvent(client, {
          runId,
          connectorId: this.connectorId,
          axis: 'publication',
          fromStatus: publicationFrom,
          toStatus: 'skipped',
          reasonCode: 'PUBLICATION_ABANDONED'
        })
      }
      const record = await this.getWith(client, runId)
      if (record === null)
        throw new Error(`Review run ${runId} disappeared during abandonment.`)
      return record
    })
  }
  /** Recoverable runs, as a projection rather than a bare array: a row the contract cannot
   * represent is returned in `dropped` instead of aborting the read.
   *
   * An uncertain submission is recoverable when it has no live claim, or when its claim has
   * expired, so a stalled recovery becomes claimable again. The lease is `claimed_at`; the
   * observation heartbeat writes `observed_at` only, so it can never extend this lease. */
  async listSubmissionRecoveries(): Promise<RunRowsProjection> {
    this.ready()
    const result = await this.pool.query<ReviewRunRow>(
      `${RUN_SELECT}
      WHERE r.connector_id=$1
        AND e.status='uncertain'
        AND (
          e.claim_token IS NULL
          OR e.claimed_at <= clock_timestamp()-($2*interval '1 millisecond')
        )
      ORDER BY e.updated_at`,
      [this.connectorId, this.claimTimeoutMs]
    )
    return projectRunRows(result.rows)
  }
  async claimSubmissionRecovery(runId: string): Promise<string | null> {
    return await this.executions.claimSubmissionRecovery(runId)
  }
  /** Commit an accepted replay: the submission is confirmed, so execution is now queued.
   *
   * `started_at` is filled here, not when the run entered `uncertain`: that state records an
   * unconfirmed submission, so it deliberately has no start. A resolved replay means the Runner
   * did accept it, making this the instant execution actually began. Leaving it NULL would
   * produce a `queued` run with no start, a state no other path can reach. */
  async completeSubmissionRecovery(
    runId: string,
    token: string
  ): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      // An uncertain submission keeps publication pending, so a successful replay moves only the
      // execution axis and needs no publication change. The EXISTS clause asserts that premise
      // instead of assuming it: if some other path already concluded the publication (skipped or
      // failed), queueing the execution would leave a run that is running while its result can no
      // longer be delivered. Matching nothing returns false, which the caller reports as a lost
      // claim instead of committing that inconsistent snapshot.
      const result = await client.query(
        `
        UPDATE executions
        SET status='queued', claim_token=NULL, claimed_at=NULL,
            started_at=COALESCE(started_at, clock_timestamp()),
            failure_code=NULL, failure_message=NULL,
            observed_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2
          AND status='uncertain' AND claim_token=$3
          AND EXISTS (
            SELECT 1 FROM publications p
            WHERE p.run_id=executions.run_id AND p.connector_id=executions.connector_id
              AND p.status='pending'
          )
      `,
        [runId, this.connectorId, token]
      )
      if (result.rowCount !== 1) return false
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'execution',
        fromStatus: 'uncertain',
        toStatus: 'queued'
      })
      return true
    })
  }
  async releaseSubmissionRecovery(
    runId: string,
    token: string
  ): Promise<boolean> {
    this.ready()
    return await this.executions.releaseSubmissionRecovery(runId, token)
  }
  async failSubmissionRecovery(
    runId: string,
    token: string,
    error: { code?: string | null; message: string }
  ): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      const result = await client.query(
        `
        UPDATE executions
        SET status='failed', claim_token=NULL, claimed_at=NULL,
            failure_code=$4, failure_message=$5,
            finished_at=clock_timestamp(),
            observed_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2
          AND status='uncertain' AND claim_token=$3
      `,
        [runId, this.connectorId, token, error.code ?? null, error.message]
      )
      if (result.rowCount !== 1) return false
      // A rejected replay proves there is nothing to publish: converge a publication that is
      // still pending or in flight, in this same transaction.
      const fromStatus = await abandonInFlightPublication(
        client,
        this.connectorId,
        runId
      )
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'execution',
        fromStatus: 'uncertain',
        toStatus: 'failed',
        reasonCode: error.code ?? null
      })
      if (fromStatus !== null) {
        await appendEvent(client, {
          runId,
          connectorId: this.connectorId,
          axis: 'publication',
          fromStatus,
          toStatus: 'skipped',
          // The publication was abandoned because execution was conclusively rejected, not for
          // the rejection's own reason: that code belongs to the runner event above. Keeping it
          // constant is what lets the contract declare this edge's reason exactly.
          reasonCode: 'PUBLICATION_ABANDONED'
        })
      }
      return true
    })
  }
  /** Active (queued/running) runs for this connector, as a projection: a row the contract
   * cannot represent is returned in `dropped` instead of aborting the read for every run. */
  async listActiveRuns(): Promise<RunRowsProjection> {
    this.ready()
    const result = await this.pool.query<ReviewRunRow>(
      `${RUN_SELECT}
      WHERE r.connector_id=$1
        AND e.status IN ('queued','running')
      ORDER BY e.updated_at`,
      [this.connectorId]
    )
    return projectRunRows(result.rows)
  }
  /** Record that the Runner was observed just now, without changing state. Writes only
   * `observed_at`, so a heartbeat can never extend the recovery lease. */
  async touchObservation(runId: string): Promise<void> {
    return await this.executions.touchObservation(runId)
  }
  async markRunning(runId: string): Promise<boolean> {
    return await this.executions.markRunning(runId)
  }
  async recordArtifactStorage(
    runId: string,
    storage: RunnerArtifactStorage | undefined
  ): Promise<void> {
    return await this.executions.recordArtifactStorage(runId, storage)
  }
  async recordRunnerSuccess(
    runId: string,
    workflowResult: unknown,
    storage: RunnerArtifactStorage | undefined
  ): Promise<boolean> {
    return await this.executions.recordRunnerSuccess(
      runId,
      workflowResult,
      storage
    )
  }
  async failRunnerExecution(
    runId: string,
    error: { code?: string | null; message: string },
    storage?: RunnerArtifactStorage
  ): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      // As with success, capture the pre-update status so the event names the real origin.
      const run = await client.query<{ from_status: string }>(
        `
        WITH previous AS (
          SELECT run_id, status FROM executions
          WHERE run_id=$1 AND connector_id=$2 AND status IN ('queued','running')
          FOR UPDATE
        )
        UPDATE executions e
        SET status='failed', claim_token=NULL, claimed_at=NULL,
            failure_code=$3, failure_message=$4, artifact_storage=$5::jsonb,
            finished_at=clock_timestamp(),
            observed_at=clock_timestamp(), updated_at=clock_timestamp()
        FROM previous
        WHERE e.run_id=previous.run_id
        RETURNING previous.status AS from_status
      `,
        [
          runId,
          this.connectorId,
          error.code ?? null,
          error.message,
          storage === undefined
            ? null
            : JSON.stringify(normalizeArtifactStorage(storage, `run ${runId}`))
        ]
      )
      if (run.rowCount !== 1) return false
      // A terminal execution failure ends the run, so the requester is told about it. The notice is
      // keyed by the run rather than by preparation: this failure is not a preparation failure,
      // and leaving it unannounced meant a run could stop partway with no reply ever posted.
      await client.query(
        `INSERT INTO run_failure_notices (run_id,connector_id,status,failure_stage,failure_code)
         VALUES ($1,$2,'pending','execution',$3) ON CONFLICT (run_id) DO NOTHING`,
        [runId, this.connectorId, error.code ?? null]
      )
      // A terminal Runner failure has no result to publish. Keep the publication row only as the
      // durable declaration that publication is not applicable, converging an in-flight one too.
      const fromStatus = await abandonInFlightPublication(
        client,
        this.connectorId,
        runId
      )
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'execution',
        fromStatus: run.rows[0]?.from_status ?? null,
        toStatus: 'failed',
        reasonCode: error.code ?? null
      })
      // The publication axis moved too; record it so the audit trail matches the snapshot. The
      // returned status keeps the event honest when the publication was already concluded.
      if (fromStatus !== null) {
        await appendEvent(client, {
          runId,
          connectorId: this.connectorId,
          axis: 'publication',
          fromStatus,
          toStatus: 'skipped',
          reasonCode: 'PUBLICATION_ABANDONED'
        })
      }
      return true
    })
  }
  /** Claim one known run for publication.
   *
   * Inlined here rather than forwarded to `PublicationStore`: the claim condition reads the
   * execution axis (`executions.status='succeeded'` and a non-null workflow_result), so it is
   * cross-axis orchestration, not a single-axis publication write.
   *
   * A claimable run must have a JSON result that is not the JSON value `null`: `IS NOT NULL`
   * accepts a stored JSON `null`, but node-pg reads it back as JS `null`, which would poison
   * the claim path. Excluding it keeps a null-result run from blocking publication for every
   * other run behind it.
   *
   * `started_at` is set on the first claim only: a retryable failure returns the row to
   * pending and it is claimed again, and that must not move when the publication phase began. */
  async claimPublication(runId: string): Promise<string | null> {
    const token = crypto.randomUUID()
    return await transaction(this.pool, async (client) => {
      // Capture the pre-update state so the audit event names where the claim came from:
      // a fresh `pending` claim versus reclaiming an expired `publishing` lease.
      const result = await client.query<{
        claim_token: string
        from_status: PublicationStatus
      }>(
        `
        WITH previous AS (
          SELECT run_id, status FROM publications
          WHERE run_id=$1 AND connector_id=$3
          FOR UPDATE
        )
        UPDATE publications p
        SET status='publishing', claim_token=$2, claimed_at=clock_timestamp(),
            started_at=COALESCE(p.started_at, clock_timestamp()),
            failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
        FROM previous, executions e
        WHERE p.run_id=previous.run_id AND previous.run_id=$1 AND p.connector_id=$3
          AND e.run_id=p.run_id AND e.connector_id=p.connector_id
          AND e.status='succeeded' AND jsonb_typeof(e.workflow_result) <> 'null'
          AND (
            previous.status='pending'
            OR (previous.status='publishing'
              AND p.claimed_at <= clock_timestamp()-($4*interval '1 millisecond'))
          )
        RETURNING p.claim_token, previous.status AS from_status
      `,
        [runId, token, this.connectorId, this.claimTimeoutMs]
      )
      const claimed = result.rows[0]
      if (claimed === undefined) return null
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'publication',
        fromStatus: claimed.from_status,
        toStatus: 'publishing',
        reasonCode:
          claimed.from_status === 'publishing'
            ? 'PUBLICATION_LEASE_EXPIRED'
            : null
      })
      return claimed.claim_token
    })
  }
  /**
   * Claim the next publishable run, optionally holding the request until one appears.
   *
   * Like `claimPublication`, this stays here because selecting publishable work joins the
   * execution axis and the result is a full cross-axis record.
   *
   * The wait lives here because the state it looks for is in this database: a re-check
   * costs one indexed query per tick for the single caller that waits. Waiting on a
   * remote service is a different trade, since there each re-check is a round trip per
   * watched item — which is why the Runner status query deliberately offers no such
   * option.
   */
  async claimNextPublication(waitMs = 0): Promise<PublicationWork | null> {
    // The contract declares `wait_ms` a non-negative integer, so the handler passes a value the
    // schema already bounded below. Clamp it here anyway: the cap keeps one request from holding
    // a connection longer than intended, and a store method should not assume its caller
    // validated on its behalf.
    const boundedWaitMs =
      Number.isFinite(waitMs) && waitMs > 0 ? Math.min(waitMs, 30_000) : 0
    const deadline = Date.now() + boundedWaitMs
    for (;;) {
      const work = await this.claimNextPublicationOnce()
      if (work !== null || Date.now() >= deadline) return work
      await new Promise((resolve) =>
        setTimeout(resolve, CLAIM_WAIT_INTERVAL_MS)
      )
    }
  }

  /** Claim the oldest publishable run for this connector.
   *
   * The SELECT applies the same JSON-`null` guard as `claimPublication`: a stored JSON `null`
   * result must not be selected as claimable work, or the claim would throw and roll back on the
   * same row on every poll.
   *
   * `started_at` is written with `COALESCE` so only the first claim marks when the publication
   * phase began; a retryable failure returns the row to pending and is claimed again. */
  private async claimNextPublicationOnce(): Promise<PublicationWork | null> {
    return await transaction(this.pool, async (client) => {
      const candidate = await client.query<{
        run_id: string
        status: PublicationStatus
      }>(
        `
        SELECT p.run_id, p.status
        FROM publications p
        JOIN executions e ON e.run_id=p.run_id AND e.connector_id=p.connector_id
        WHERE p.connector_id=$1
          AND e.status='succeeded' AND jsonb_typeof(e.workflow_result) <> 'null'
          AND (p.status='pending' OR
            (p.status='publishing' AND p.claimed_at <= clock_timestamp()-($2*interval '1 millisecond')))
        ORDER BY p.updated_at
        FOR UPDATE OF p SKIP LOCKED
        LIMIT 1
      `,
        [this.connectorId, this.claimTimeoutMs]
      )
      const candidateRow = candidate.rows[0]
      if (candidateRow === undefined) return null
      const runId = candidateRow.run_id
      const token = crypto.randomUUID()
      // Restate the claimable condition instead of relying on the SELECT's row lock alone.
      // The lock makes this safe today; repeating the predicate keeps it safe if the two
      // statements are ever split, and it guarantees the UPDATE cannot silently overwrite a
      // terminal publication state that the SELECT could no longer have selected. The
      // `status` equality pins the row the event's `from_status` was captured from, so the
      // audit log cannot claim an origin the row no longer had.
      const claimed = await client.query(
        `
        UPDATE publications SET status='publishing', claim_token=$3,
          claimed_at=clock_timestamp(),
          started_at=COALESCE(started_at, clock_timestamp()),
          failure_code=NULL, failure_message=NULL,
          updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2 AND status=$4
      `,
        [runId, this.connectorId, token, candidateRow.status]
      )
      if (claimed.rowCount !== 1)
        throw new Error(
          `Publication work changed while being claimed: ${runId}`
        )
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'publication',
        fromStatus: candidateRow.status,
        toStatus: 'publishing',
        reasonCode:
          candidateRow.status === 'publishing'
            ? 'PUBLICATION_LEASE_EXPIRED'
            : null
      })
      const result = await client.query<ReviewRunRow>(
        `${RUN_SELECT}
        WHERE r.run_id=$1 AND r.connector_id=$2`,
        [runId, this.connectorId]
      )
      const row = result.rows[0]
      if (row === undefined || row.execution.workflow_result === null)
        throw new Error(`Claimed publication work is incomplete: ${runId}`)
      return {
        ...rowToRecord(row),
        workflow_result: row.execution.workflow_result,
        claim_token: token
      }
    })
  }
  publicationHeartbeatIntervalMs(): number {
    return this.publications.heartbeatIntervalMs()
  }
  async renewPublicationClaim(runId: string, token: string): Promise<boolean> {
    return await this.publications.renewClaim(runId, token)
  }
  async initializePublicationSteps(
    runId: string,
    token: string,
    stepKeys: string[]
  ): Promise<void> {
    return await this.publications.initializePublicationSteps(
      runId,
      token,
      stepKeys
    )
  }
  async listPublicationSteps(runId: string): Promise<PublicationStepRecord[]> {
    return await this.publications.listPublicationSteps(runId)
  }
  async requirePublicationStepClaim(
    runId: string,
    token: string,
    stepKey: string
  ): Promise<void> {
    return await this.publications.requirePublicationStepClaim(
      runId,
      token,
      stepKey
    )
  }
  async completePublicationStep(
    runId: string,
    token: string,
    stepKey: string,
    remote: { id?: string | null; url?: string | null } = {}
  ): Promise<boolean> {
    return await this.publications.completePublicationStep(
      runId,
      token,
      stepKey,
      remote
    )
  }
  async failPublicationStep(
    runId: string,
    token: string,
    stepKey: string,
    error: { code?: string | null; message: string },
    options: { retry?: boolean } = {}
  ): Promise<boolean> {
    return await this.publications.failPublicationStep(
      runId,
      token,
      stepKey,
      error,
      options
    )
  }
  async completePublication(runId: string, token: string): Promise<boolean> {
    return await this.publications.complete(runId, token)
  }
  async failPublication(
    runId: string,
    token: string,
    error: { code?: string | null; message: string },
    options: { retry: boolean }
  ): Promise<boolean> {
    return await this.publications.fail(runId, token, error, options)
  }
  async failPreparation(
    runId: string,
    token: string,
    error: { code?: string | null; message: string },
    options: { retry: boolean; retryAfterMs?: number } = { retry: false }
  ): Promise<{ retry_scheduled: boolean }> {
    this.ready()
    return await this.preparations.fail(runId, token, error, options)
  }
  async close(): Promise<void> {
    await this.pool.end()
  }
}
