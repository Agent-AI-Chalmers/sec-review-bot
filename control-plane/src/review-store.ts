// Implements Control Plane's durable review trunk and its read projection, and orchestrates
// the cross-axis transitions that must move more than one lifecycle axis in one transaction.
//
// Axis ownership:
// - `execution-store.ts` owns single-axis execution writes (status transitions, observation
//   heartbeat, artifact/result, submission-recovery claims).
// - `preparation-store.ts` / `publication-store.ts` own their own axes.
// - This store owns the run trunk, the full-record projection (`RUN_SELECT`/`rowToRecord`),
//   and cross-axis transitions (submit -> queued, execution failure -> publication skipped,
//   recovery -> publication re-pending). A cross-axis transition is owned by the axis that
//   initiates it; preparations initiating an execution skip is therefore in that store.
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
  type PreparationFailureNoticeWork,
  type PreparationWork
} from './preparation-store.js'
import { PublicationStore } from './publication-store.js'
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
  PreparationFailureNoticeWork,
  PreparationWork
} from './preparation-store.js'

interface ReviewRunRow {
  run_id: string
  workflow: WorkflowName
  publish_context: JsonObject
  runner_input: JsonObject | null
  runner_status: RunnerStatus
  runner_failure_code: string | null
  runner_failure_message: string | null
  artifact_storage: RunnerArtifactStorage | null
  workflow_result: unknown | null
  publication_status: PublicationStatus
  created_at: Date | string
  created_at_cursor: string
  runner_updated_at: Date | string | null
  execution_missing: boolean
  submitted_at: Date | string | null
  publication_updated_at: Date | string
  published_at: Date | string | null
  publication_failure_code: string | null
  publication_failure_message: string | null
  ingress_kind: 'github_webhook' | 'github_actions_dispatch' | null
  ingress_key: string | null
  preparation_status: 'pending' | 'preparing' | 'submitted' | 'failed' | null
  preparation_attempt_count: number | null
  preparation_updated_at: Date | string | null
  preparation_failure_code: string | null
  preparation_failure_message: string | null
  preparation_failure_notice_status:
    'pending' | 'delivering' | 'delivered' | 'skipped' | null
}

const DEFAULT_CLAIM_TIMEOUT_MS = 10 * 60 * 1000
/** How often a waiting publication claim re-checks for work. The state is a local indexed
 * query, so this trades a cheap read against how quickly the caller starts publishing. */
const CLAIM_WAIT_INTERVAL_MS = 250

const RUN_SELECT = `
  SELECT r.run_id, r.workflow, p.input AS publish_context,
    r.ingress_kind, r.ingress_key,
    r.created_at,
    -- Full-precision (microsecond) UTC timestamp for keyset cursors. node-pg maps
    -- created_at to a millisecond JS Date, so a cursor built from the truncated
    -- value skips every row in the same millisecond; this string keeps the
    -- microseconds for an exact (created_at, run_id) < boundary.
    to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
    e.input AS runner_input, e.status AS runner_status,
    e.failure_code AS runner_failure_code, e.failure_message AS runner_failure_message,
    e.artifact_storage, e.workflow_result,
    e.observed_at AS runner_updated_at, e.submitted_at,
    (e.run_id IS NULL) AS execution_missing,
    p.status AS publication_status, p.updated_at AS publication_updated_at,
    p.published_at,
    p.failure_code AS publication_failure_code, p.failure_message AS publication_failure_message,
    pr.status AS preparation_status, pr.attempt_count AS preparation_attempt_count,
    pr.updated_at AS preparation_updated_at, pr.failure_code AS preparation_failure_code,
    pr.failure_message AS preparation_failure_message,
    n.status AS preparation_failure_notice_status
  FROM review_runs r
  JOIN publications p ON p.run_id = r.run_id
  -- LEFT JOIN so a run that somehow lacks its execution row is surfaced (and reported), not
  -- silently dropped from every read.
  LEFT JOIN executions e ON e.run_id = r.run_id AND e.connector_id = r.connector_id
  LEFT JOIN preparations pr
    ON pr.run_id = r.run_id AND pr.connector_id = r.connector_id
  LEFT JOIN preparation_failure_notices n
    ON n.run_id = r.run_id AND n.connector_id = r.connector_id
`

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString()
}
function rowToRecord(row: ReviewRunRow): ReviewRunRecord {
  if (row.execution_missing) {
    // A run without its execution row is corrupt, not a valid record. Throwing makes the
    // projection report it in `dropped` instead of silently omitting or misrepresenting it.
    throw new Error(`run ${row.run_id} has no executions row`)
  }
  const publicationFailure = row.publication_status === 'failed'
  return {
    run_id: row.run_id,
    workflow: row.workflow,
    publish_context: row.publish_context,
    ...(row.runner_input === null ? {} : { runner_input: row.runner_input }),
    preparation:
      row.preparation_status === null ||
      row.preparation_attempt_count === null ||
      row.preparation_updated_at === null
        ? null
        : {
            status: row.preparation_status,
            attempt_count: row.preparation_attempt_count,
            updated_at: iso(row.preparation_updated_at),
            failure_code: row.preparation_failure_code,
            failure_notice_status: row.preparation_failure_notice_status
          },
    runner_status: row.runner_status,
    publication_status: row.publication_status,
    created_at: iso(row.created_at),
    submitted_at: row.submitted_at === null ? null : iso(row.submitted_at),
    // `runner_updated_at` is the execution axis' observed_at; the missing-execution guard
    // above narrows it to a real timestamp.
    execution_updated_at: iso(row.runner_updated_at as Date | string),
    publication_updated_at: iso(row.publication_updated_at),
    published_at: row.published_at === null ? null : iso(row.published_at),
    // The run-level failure code names whichever axis actually failed: publication, then
    // execution, then preparation. A skipped execution therefore still reports the
    // preparation failure that caused it, without pretending execution itself failed.
    failure_code: publicationFailure
      ? row.publication_failure_code
      : (row.runner_failure_code ?? row.preparation_failure_code),
    failure_message: publicationFailure
      ? row.publication_failure_message
      : (row.runner_failure_message ?? row.preparation_failure_message),
    artifact_storage: normalizeArtifactStorage(
      row.artifact_storage,
      `run ${row.run_id}`
    ),
    ...(row.ingress_kind ? { ingress_kind: row.ingress_kind } : {}),
    ...(row.ingress_key ? { ingress_key: row.ingress_key } : {})
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
      dropped.push({ run_id: row.run_id, error })
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
  private initialized = false

  constructor({
    connectionString,
    connectorId = process.env.CONNECTOR_ID?.trim() || 'github-app:default',
    claimTimeoutMs = DEFAULT_CLAIM_TIMEOUT_MS,
    pool
  }: {
    connectionString?: string
    connectorId?: string
    claimTimeoutMs?: number
    pool?: Pool
  } = {}) {
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
    await client.query(
      `INSERT INTO preparations
        (run_id,connector_id,input_version,input,status,claim_token,claimed_at,attempt_count)
       VALUES ($1,$2,$3,$4::jsonb,'preparing',$5,clock_timestamp(),1)`,
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
      axis: 'runner',
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
      if (existing.rows[0] === undefined) throw error
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
    const run = await this.getRun(runId)
    if (run === null) throw new Error(`Review run does not exist: ${runId}`)
    const result = await this.pool.query(
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
  async claimNextPreparationFailureNotice(): Promise<PreparationFailureNoticeWork | null> {
    this.ready()
    return await this.preparations.claimNextFailureNotice()
  }
  async completePreparationFailureNotice(
    runId: string,
    token: string,
    delivered: boolean
  ): Promise<boolean> {
    this.ready()
    return await this.preparations.completeFailureNotice(
      runId,
      token,
      delivered
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
      if (run === null) throw new Error(`Review run does not exist: ${runId}`)
      const result = await client.query(
        `
        UPDATE publications
        SET input=$2::jsonb, updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$3
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
        SET status='queued', submitted_at=COALESCE(submitted_at, clock_timestamp()),
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
             updated_at=clock_timestamp()
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
        axis: 'runner',
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
  async listEvents(runId: string): Promise<ReviewRunEvent[]> {
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
    // A row the record contract cannot represent (e.g. a run missing its execution axis) is
    // treated as absent, matching the list projection that reports it in `dropped`.
    try {
      return rowToRecord(row)
    } catch {
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
    if (options.execution_status !== undefined) {
      clauses.push(`e.status=${add(options.execution_status)}`)
    }
    if (options.publication_status !== undefined) {
      clauses.push(`p.status=${add(options.publication_status)}`)
    }
    if (options.preparation_status !== undefined) {
      clauses.push(`pr.status=${add(options.preparation_status)}`)
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
        ? Buffer.from(`${last.created_at_cursor}|${last.run_id}`).toString(
            'base64url'
          )
        : null
    const { runs, dropped } = projectRunRows(page)
    return { runs, next_cursor, dropped }
  }
  async expireStalePreparations(): Promise<number> {
    this.ready()
    return await this.preparations.expireStale()
  }
  /** Recoverable runs, as a projection rather than a bare array: a row the contract cannot
   * represent is returned in `dropped` instead of aborting the read. */
  async listSubmissionRecoveries(): Promise<RunRowsProjection> {
    const result = await this.pool.query<ReviewRunRow>(
      `${RUN_SELECT}
      WHERE r.connector_id=$1
        AND e.status='uncertain'
        AND (
          -- An uncertain submission is claimable when it has no live claim; the lease is
          -- claimed_at, so a stalled recovery becomes claimable again. Observation writes
          -- observed_at only, so a heartbeat can never extend this lease.
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
  async completeSubmissionRecovery(
    runId: string,
    token: string
  ): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      const result = await client.query(
        `
        UPDATE executions
        SET status='queued', claim_token=NULL, claimed_at=NULL,
            failure_code=NULL, failure_message=NULL,
            observed_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2
          AND status='uncertain' AND claim_token=$3
      `,
        [runId, this.connectorId, token]
      )
      if (result.rowCount !== 1) return false
      // Publication stayed `pending` throughout `uncertain` (an accepted submission could still
      // succeed), so an accepted replay needs no publication change: the run is simply queued
      // and its eventual result remains publishable.
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'runner',
        fromStatus: 'uncertain',
        toStatus: 'queued'
      })
      return true
    })
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
            observed_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2
          AND status='uncertain' AND claim_token=$3
      `,
        [runId, this.connectorId, token, error.code ?? null, error.message]
      )
      if (result.rowCount !== 1) return false
      const skipped = await client.query(
        `
        UPDATE publications
        SET status='skipped', claim_token=NULL,
            failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2 AND status='pending'
        RETURNING run_id
      `,
        [runId, this.connectorId]
      )
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'runner',
        fromStatus: 'uncertain',
        toStatus: 'failed',
        reasonCode: error.code ?? null
      })
      if (skipped.rowCount === 1) {
        await appendEvent(client, {
          runId,
          connectorId: this.connectorId,
          axis: 'publication',
          fromStatus: 'pending',
          toStatus: 'skipped',
          reasonCode: error.code ?? null
        })
      }
      return true
    })
  }
  /** Active (queued/running) runs for this connector, as a projection: a row the contract
   * cannot represent is returned in `dropped` instead of aborting the read for every run. */
  async listActiveRuns(): Promise<RunRowsProjection> {
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
        SET status='failed', failure_code=$3,
            failure_message=$4, artifact_storage=$5::jsonb,
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
      // A terminal Runner failure has no result to publish. Keep the publication
      // row only as the durable declaration that publication is not applicable.
      const skipped = await client.query(
        `
        UPDATE publications
        SET status='skipped', claim_token=NULL,
            failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2 AND status='pending'
        RETURNING run_id
      `,
        [runId, this.connectorId]
      )
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'runner',
        fromStatus: run.rows[0]?.from_status ?? null,
        toStatus: 'failed',
        reasonCode: error.code ?? null
      })
      // The publication axis moved too; record it so the audit trail matches the snapshot.
      // RETURNING keeps the event honest when the publication was already non-pending.
      if (skipped.rowCount === 1) {
        await appendEvent(client, {
          runId,
          connectorId: this.connectorId,
          axis: 'publication',
          fromStatus: 'pending',
          toStatus: 'skipped'
        })
      }
      return true
    })
  }
  /** Claim one known run for publication.
   *
   * Inlined here rather than forwarded to `PublicationStore`: the claim condition reads the
   * execution axis (`executions.status='succeeded'` and a non-null workflow_result), so it is
   * cross-axis orchestration, not a single-axis publication write. */
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
            failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
        FROM previous, executions e
        WHERE p.run_id=previous.run_id AND previous.run_id=$1 AND p.connector_id=$3
          AND e.run_id=p.run_id AND e.connector_id=p.connector_id
          -- A JSON 'null' result satisfies 'IS NOT NULL' (it is stored as the JSON
          -- value null, not SQL NULL), yet node-pg reads it back as JS null, which
          -- would poison the claim path. Exclude it so a null-result run is never
          -- claimed, instead of blocking every other publication head-of-line.
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
          -- Same JSON-null guard as claimPublication: a JSON 'null' result must not
          -- be selected as claimable work, or claimNextPublication would throw and
          -- roll back on the same row every poll.
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
          claimed_at=clock_timestamp(), failure_code=NULL, failure_message=NULL,
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
      if (row === undefined || row.workflow_result === null)
        throw new Error(`Claimed publication work is incomplete: ${runId}`)
      return {
        ...rowToRecord(row),
        workflow_result: row.workflow_result,
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
