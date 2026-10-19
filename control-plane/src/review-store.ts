// Implements Control Plane's durable review, preparation, and publication
// state machines. Claim tokens here are the sole fencing authority for writes.
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

import type {
  ControlPlaneWorkflow as WorkflowName,
  RunnerArtifactStorage
} from './contracts.js'
import { applySchemaVersions } from './database/schema-version-runner.js'
import {
  DeterministicControlPlaneError,
  PUBLICATION_STEP_ERROR_CODES
} from './errors.js'
import {
  normalizeArtifactStorage,
  type CreateReviewRunArgs,
  type PublicationStatus,
  type PublicationStepRecord,
  type PublicationWork,
  type ReviewRunAdmission,
  type ReviewRunRecord,
  type RunnerStatus
} from './shapes.js'
import {
  PreparationStore,
  type PreparationFailureNoticeWork,
  type PreparationWork
} from './preparation-store.js'

export type {
  CreateReviewRunArgs,
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
  runner_updated_at: Date | string
  publication_updated_at: Date | string
  published_at: Date | string | null
  publication_failure_code: string | null
  publication_failure_message: string | null
  ingress_kind: 'github_webhook' | 'github_actions_dispatch' | null
  ingress_key: string | null
}

const MAX_PUBLICATION_STEP_FAILURES = 3
const DEFAULT_CLAIM_TIMEOUT_MS = 10 * 60 * 1000
/** How often a waiting publication claim re-checks for work. The state is a local indexed
 * query, so this trades a cheap read against how quickly the caller starts publishing. */
const CLAIM_WAIT_INTERVAL_MS = 250

const RUN_SELECT = `
  SELECT r.run_id, r.workflow, r.publish_context, r.runner_input, r.runner_status,
    r.runner_failure_code, r.runner_failure_message, r.artifact_storage, r.workflow_result,
    r.ingress_kind, r.ingress_key,
    r.created_at, r.updated_at AS runner_updated_at,
    -- Full-precision (microsecond) UTC timestamp for keyset cursors. node-pg maps
    -- created_at to a millisecond JS Date, so a cursor built from the truncated
    -- value skips every row in the same millisecond; this string keeps the
    -- microseconds for an exact (created_at, run_id) < boundary.
    to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
    p.status AS publication_status, p.updated_at AS publication_updated_at,
    p.published_at,
    p.failure_code AS publication_failure_code, p.failure_message AS publication_failure_message
  FROM review_runs r JOIN publications p ON p.run_id = r.run_id
`

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString()
}
function rowToRecord(row: ReviewRunRow): ReviewRunRecord {
  const publicationFailure = row.publication_status === 'failed'
  return {
    run_id: row.run_id,
    workflow: row.workflow,
    publish_context: row.publish_context,
    ...(row.runner_input === null ? {} : { runner_input: row.runner_input }),
    runner_status: row.runner_status,
    publication_status: row.publication_status,
    created_at: iso(row.created_at),
    execution_updated_at: iso(row.runner_updated_at),
    publication_updated_at: iso(row.publication_updated_at),
    published_at: row.published_at === null ? null : iso(row.published_at),
    failure_code: publicationFailure
      ? row.publication_failure_code
      : row.runner_failure_code,
    failure_message: publicationFailure
      ? row.publication_failure_message
      : row.runner_failure_message,
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
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await applySchemaVersions(this.pool)
    this.initialized = true
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
      (run_id,connector_id,workflow,publish_context,runner_input,runner_status,ingress_kind,ingress_key)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,'preparing',$6,$7)`,
      [
        run.run_id,
        this.connectorId,
        run.workflow,
        JSON.stringify(run.publish_context),
        run.runner_input === undefined
          ? null
          : JSON.stringify(run.runner_input),
        run.ingress_kind ?? null,
        run.ingress_key ?? null
      ]
    )
    await client.query(
      `INSERT INTO preparations
        (run_id,connector_id,input_version,input,status,claim_token,claimed_at,attempt_count)
       VALUES ($1,$2,$3,$4::jsonb,'claimed',$5,clock_timestamp(),1)`,
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
      INSERT INTO publications (run_id,connector_id,status)
      VALUES ($1,$2,'pending')
    `,
      [run.run_id, this.connectorId]
    )
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
        if (row.runner_status === 'preparing') {
          const token = crypto.randomUUID()
          const reclaimed = await client.query(
            `
            UPDATE preparations
            SET status='claimed', claim_token=$2, claimed_at=clock_timestamp(),
                attempt_count=attempt_count+1, failure_code=NULL, failure_message=NULL,
                updated_at=clock_timestamp()
            WHERE run_id=$1 AND connector_id=$4
              AND (
                (status='pending' AND available_at <= clock_timestamp())
                OR (status='claimed' AND claimed_at <= clock_timestamp()-($3*interval '1 millisecond'))
              )
          `,
            [row.run_id, token, this.claimTimeoutMs, this.connectorId]
          )
          if (reclaimed.rowCount !== 1)
            return {
              record: rowToRecord(row),
              created: false,
              preparation_token: null
            }
          const record = await this.getWith(client, row.run_id)
          if (record === null)
            throw new Error(`Reclaimed review run was not found: ${row.run_id}`)
          return { record, created: true, preparation_token: token }
        }
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
      UPDATE review_runs
      SET publish_context=$3::jsonb, runner_input=$4::jsonb, updated_at=clock_timestamp()
      WHERE run_id=$1 AND connector_id=$5
        AND runner_status='preparing' AND EXISTS (
          SELECT 1 FROM preparations
          WHERE preparations.run_id=review_runs.run_id
            AND preparations.connector_id=$5 AND preparations.status='claimed'
            AND preparations.claim_token=$2
        )
        AND workflow=$6
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
        `Review run ${runId} cannot save prepared submission outside preparing.`
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
        UPDATE review_runs
        SET publish_context=$3::jsonb, runner_status='queued',
            runner_failure_code=NULL, runner_failure_message=NULL,
            updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$4
          AND runner_status='preparing' AND EXISTS (
            SELECT 1 FROM preparations
            WHERE preparations.run_id=review_runs.run_id
              AND preparations.connector_id=$4 AND preparations.status='claimed'
              AND preparations.claim_token=$2
          )
          AND workflow=$5
      `,
        [runId, token, JSON.stringify(context), this.connectorId, run.workflow]
      )
      if (result.rowCount !== 1)
        throw new Error(
          `Review run ${runId} cannot transition from preparing to queued.`
        )
      const completed = await client.query(
        `UPDATE preparations
         SET status='submitted', claim_token=NULL, claimed_at=NULL,
             updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='claimed'
           AND claim_token=$3`,
        [runId, this.connectorId, token]
      )
      if (completed.rowCount !== 1)
        throw new Error(
          `Preparation ${runId} lost its claim before the queued transition completed.`
        )
    })
  }
  async getRun(runId: string): Promise<ReviewRunRecord | null> {
    this.ready()
    const result = await this.pool.query<ReviewRunRow>(
      `${RUN_SELECT}
      WHERE r.run_id=$1 AND r.connector_id=$2`,
      [runId, this.connectorId]
    )
    return result.rows[0] === undefined ? null : rowToRecord(result.rows[0])
  }

  private async listRunRows(
    options: {
      limit?: number
      cursor?: string
      execution_status?: RunnerStatus
      publication_status?: PublicationStatus
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
      clauses.push(`r.runner_status=${add(options.execution_status)}`)
    }
    if (options.publication_status !== undefined) {
      clauses.push(`p.status=${add(options.publication_status)}`)
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
        AND (
          (r.runner_status='failed' AND r.runner_failure_code='SUBMISSION_STATE_UNCERTAIN')
          OR (r.runner_status='recovering' AND r.updated_at <= clock_timestamp()-($2*interval '1 millisecond'))
        )
      ORDER BY r.updated_at`,
      [this.connectorId, this.claimTimeoutMs]
    )
    return projectRunRows(result.rows)
  }
  async claimSubmissionRecovery(runId: string): Promise<string | null> {
    const token = crypto.randomUUID()
    const result = await this.pool.query<{ recovery_claim_token: string }>(
      `
      UPDATE review_runs
      SET runner_status='recovering', recovery_claim_token=$2, updated_at=clock_timestamp()
      WHERE run_id=$1 AND connector_id=$3
        AND (
          (runner_status='failed' AND runner_failure_code='SUBMISSION_STATE_UNCERTAIN')
          OR (runner_status='recovering' AND updated_at <= clock_timestamp()-($4*interval '1 millisecond'))
        )
      RETURNING recovery_claim_token
    `,
      [runId, token, this.connectorId, this.claimTimeoutMs]
    )
    return result.rows[0]?.recovery_claim_token ?? null
  }
  async completeSubmissionRecovery(
    runId: string,
    token: string
  ): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      const result = await client.query(
        `
        UPDATE review_runs
        SET runner_status='queued', recovery_claim_token=NULL,
            runner_failure_code=NULL, runner_failure_message=NULL, updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2
          AND runner_status='recovering' AND recovery_claim_token=$3
      `,
        [runId, this.connectorId, token]
      )
      if (result.rowCount !== 1) return false
      await client.query(
        `
        UPDATE publications
        SET status='pending', claim_token=NULL, failure_code=NULL,
            failure_message=NULL, updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2 AND status='skipped'
      `,
        [runId, this.connectorId]
      )
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
        UPDATE review_runs
        SET runner_status='failed', recovery_claim_token=NULL,
            runner_failure_code=$4, runner_failure_message=$5, updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2
          AND runner_status='recovering' AND recovery_claim_token=$3
      `,
        [runId, this.connectorId, token, error.code ?? null, error.message]
      )
      if (result.rowCount !== 1) return false
      await client.query(
        `
        UPDATE publications
        SET status='skipped', claim_token=NULL,
            failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2 AND status='pending'
      `,
        [runId, this.connectorId]
      )
      return true
    })
  }
  /** Active (queued/running) runs for this connector, as a projection: a row the contract
   * cannot represent is returned in `dropped` instead of aborting the read for every run. */
  async listActiveRuns(): Promise<RunRowsProjection> {
    const result = await this.pool.query<ReviewRunRow>(
      `${RUN_SELECT}
      WHERE r.connector_id=$1
        AND r.runner_status IN ('queued','running')
      ORDER BY r.updated_at`,
      [this.connectorId]
    )
    return projectRunRows(result.rows)
  }
  async markRunning(runId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
      UPDATE review_runs
      SET runner_status='running', updated_at=clock_timestamp()
      WHERE run_id=$1 AND connector_id=$2 AND runner_status='queued'
    `,
      [runId, this.connectorId]
    )
    return result.rowCount === 1
  }
  async recordArtifactStorage(
    runId: string,
    storage: RunnerArtifactStorage | undefined
  ): Promise<void> {
    if (storage === undefined) return
    await this.pool.query(
      `
      UPDATE review_runs
      SET artifact_storage=$3::jsonb, updated_at=clock_timestamp()
      WHERE run_id=$1 AND connector_id=$2
    `,
      [
        runId,
        this.connectorId,
        JSON.stringify(normalizeArtifactStorage(storage, `run ${runId}`))
      ]
    )
  }
  async recordRunnerSuccess(
    runId: string,
    workflowResult: unknown,
    storage: RunnerArtifactStorage | undefined
  ): Promise<boolean> {
    const result = await this.pool.query(
      `
      UPDATE review_runs
      SET runner_status='succeeded', workflow_result=$3::jsonb,
          artifact_storage=$4::jsonb, runner_failure_code=NULL,
          runner_failure_message=NULL, updated_at=clock_timestamp()
      WHERE run_id=$1 AND connector_id=$2 AND runner_status IN ('queued','running')
    `,
      [
        runId,
        this.connectorId,
        JSON.stringify(workflowResult),
        storage === undefined
          ? null
          : JSON.stringify(normalizeArtifactStorage(storage, `run ${runId}`))
      ]
    )
    return result.rowCount === 1
  }
  async failRunnerExecution(
    runId: string,
    error: { code?: string | null; message: string },
    storage?: RunnerArtifactStorage
  ): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      const run = await client.query(
        `
        UPDATE review_runs
        SET runner_status='failed', runner_failure_code=$3,
            runner_failure_message=$4, artifact_storage=$5::jsonb,
            updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2 AND runner_status IN ('queued','running')
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
      await client.query(
        `
        UPDATE publications
        SET status='skipped', claim_token=NULL,
            failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2 AND status='pending'
      `,
        [runId, this.connectorId]
      )
      return true
    })
  }
  async claimPublication(runId: string): Promise<string | null> {
    const token = crypto.randomUUID()
    const result = await this.pool.query<{ claim_token: string }>(
      `
      UPDATE publications p
      SET status='publishing', claim_token=$2, claimed_at=clock_timestamp(),
          failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
      FROM review_runs r
      WHERE p.run_id=$1 AND p.connector_id=$3 AND r.run_id=p.run_id
        -- A JSON 'null' result satisfies 'IS NOT NULL' (it is stored as the JSON
        -- value null, not SQL NULL), yet node-pg reads it back as JS null, which
        -- would poison the claim path. Exclude it so a null-result run is never
        -- claimed, instead of blocking every other publication head-of-line.
        AND r.runner_status='succeeded' AND jsonb_typeof(r.workflow_result) <> 'null'
        AND (
          p.status='pending'
          OR (p.status='publishing' AND p.claimed_at <= clock_timestamp()-($4*interval '1 millisecond'))
        )
      RETURNING p.claim_token
    `,
      [runId, token, this.connectorId, this.claimTimeoutMs]
    )
    return result.rows[0]?.claim_token ?? null
  }
  /**
   * Claim the next publishable run, optionally holding the request until one appears.
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
      const candidate = await client.query<{ run_id: string }>(
        `
        SELECT p.run_id
        FROM publications p JOIN review_runs r ON r.run_id=p.run_id
        WHERE p.connector_id=$1 AND r.connector_id=$1
          -- Same JSON-null guard as claimPublication: a JSON 'null' result must not
          -- be selected as claimable work, or claimNextPublication would throw and
          -- roll back on the same row every poll.
          AND r.runner_status='succeeded' AND jsonb_typeof(r.workflow_result) <> 'null'
          AND (p.status='pending' OR
            (p.status='publishing' AND p.claimed_at <= clock_timestamp()-($2*interval '1 millisecond')))
        ORDER BY p.updated_at
        FOR UPDATE OF p SKIP LOCKED
        LIMIT 1
      `,
        [this.connectorId, this.claimTimeoutMs]
      )
      const runId = candidate.rows[0]?.run_id
      if (runId === undefined) return null
      const token = crypto.randomUUID()
      await client.query(
        `
        UPDATE publications SET status='publishing', claim_token=$3,
          claimed_at=clock_timestamp(), failure_code=NULL, failure_message=NULL,
          updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2
      `,
        [runId, this.connectorId, token]
      )
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
    return Math.max(100, Math.min(30_000, Math.floor(this.claimTimeoutMs / 3)))
  }
  async renewPublicationClaim(runId: string, token: string): Promise<boolean> {
    const result = await this.pool.query(
      `
      UPDATE publications
      SET claimed_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE run_id=$1 AND connector_id=$2
        AND status='publishing' AND claim_token=$3
    `,
      [runId, this.connectorId, token]
    )
    return result.rowCount === 1
  }
  async initializePublicationSteps(
    runId: string,
    token: string,
    stepKeys: string[]
  ): Promise<void> {
    const uniqueKeys = [...new Set(stepKeys)].sort()
    if (uniqueKeys.length !== stepKeys.length)
      throw new DeterministicControlPlaneError(
        `Publication ${runId} contains duplicate step keys.`,
        PUBLICATION_STEP_ERROR_CODES.set_duplicate
      )
    await transaction(this.pool, async (client) => {
      const owner = await client.query(
        `
        SELECT 1 FROM publications
        WHERE run_id=$1 AND connector_id=$2
          AND status='publishing' AND claim_token=$3
        FOR UPDATE
      `,
        [runId, this.connectorId, token]
      )
      if (owner.rowCount !== 1)
        throw new Error(
          `Publication claim was lost before steps were initialized: ${runId}`
        )
      const existing = await client.query<{ step_key: string }>(
        `
        SELECT step_key FROM publication_steps
        WHERE run_id=$1 AND connector_id=$2
        ORDER BY step_key
      `,
        [runId, this.connectorId]
      )
      if (existing.rowCount === 0) {
        for (const stepKey of uniqueKeys) {
          await client.query(
            `
            INSERT INTO publication_steps (connector_id,run_id,step_key,status)
            VALUES ($1,$2,$3,'pending')
          `,
            [this.connectorId, runId, stepKey]
          )
        }
        return
      }
      const persisted = existing.rows.map((row) => row.step_key).sort()
      if (JSON.stringify(persisted) !== JSON.stringify(uniqueKeys)) {
        throw new DeterministicControlPlaneError(
          `Publication step set changed for run ${runId}.`,
          PUBLICATION_STEP_ERROR_CODES.set_changed
        )
      }
    })
  }
  async listPublicationSteps(runId: string): Promise<PublicationStepRecord[]> {
    const result = await this.pool.query<PublicationStepRecord>(
      `
      SELECT step_key,status,failure_count,remote_object_id,remote_object_url,
             failure_code,failure_message
      FROM publication_steps
      WHERE run_id=$1 AND connector_id=$2
      ORDER BY step_key
    `,
      [runId, this.connectorId]
    )
    return result.rows
  }
  private async claimPublicationStep(
    runId: string,
    token: string,
    stepKey: string
  ): Promise<boolean> {
    // A running step may belong to the expired publication owner. The new
    // owner reclaims it under the new publication token, then reconciles the
    // stable remote identity before issuing another side effect.
    const result = await this.pool.query(
      `
      UPDATE publication_steps s
      SET status='running', updated_at=clock_timestamp()
      FROM publications p
      WHERE s.run_id=$1 AND s.connector_id=$2 AND s.step_key=$3
        AND (s.status IN ('pending','running') OR (s.status='failed' AND s.failure_count<$5))
        AND p.run_id=s.run_id AND p.connector_id=s.connector_id
        AND p.status='publishing' AND p.claim_token=$4
    `,
      [runId, this.connectorId, stepKey, token, MAX_PUBLICATION_STEP_FAILURES]
    )
    return result.rowCount === 1
  }
  async requirePublicationStepClaim(
    runId: string,
    token: string,
    stepKey: string
  ): Promise<void> {
    if (await this.claimPublicationStep(runId, token, stepKey)) return

    // Retry exhaustion is a persisted step outcome, not merely an exception
    // observed by one publisher. The current publication owner records it once.
    await this.pool.query(
      `
      UPDATE publication_steps s
      SET status='terminal_failed', updated_at=clock_timestamp()
      FROM publications p
      WHERE s.run_id=$1 AND s.connector_id=$2 AND s.step_key=$3
        AND s.status='failed' AND s.failure_count>=$5
        AND p.run_id=s.run_id AND p.connector_id=s.connector_id
        AND p.status='publishing' AND p.claim_token=$4
    `,
      [runId, this.connectorId, stepKey, token, MAX_PUBLICATION_STEP_FAILURES]
    )
    const step = (await this.listPublicationSteps(runId)).find(
      (item) => item.step_key === stepKey
    )
    if (step?.status === 'terminal_failed') {
      throw new DeterministicControlPlaneError(
        `Publication step exhausted its retry budget: ${stepKey}`,
        PUBLICATION_STEP_ERROR_CODES.retry_exhausted
      )
    }
    throw new DeterministicControlPlaneError(
      `Publication step is not claimable: ${stepKey}`,
      PUBLICATION_STEP_ERROR_CODES.not_claimable
    )
  }
  async completePublicationStep(
    runId: string,
    token: string,
    stepKey: string,
    remote: { id?: string | null; url?: string | null } = {}
  ): Promise<boolean> {
    // A publication token fences every step commit, not only the final run
    // state. This prevents a timed-out worker from recording stale remote data.
    const result = await this.pool.query(
      `
      UPDATE publication_steps s
      SET status='succeeded', remote_object_id=$5, remote_object_url=$6,
          failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
      FROM publications p
      WHERE s.run_id=$1 AND s.connector_id=$2 AND s.step_key=$3 AND s.status='running'
        AND p.run_id=s.run_id AND p.connector_id=s.connector_id
        AND p.status='publishing' AND p.claim_token=$4
    `,
      [
        runId,
        this.connectorId,
        stepKey,
        token,
        remote.id ?? null,
        remote.url ?? null
      ]
    )
    return result.rowCount === 1
  }
  async failPublicationStep(
    runId: string,
    token: string,
    stepKey: string,
    error: { code?: string | null; message: string },
    options: { retry?: boolean } = {}
  ): Promise<boolean> {
    const result = await this.pool.query(
      `
      UPDATE publication_steps s
      SET status=$7, failure_count=s.failure_count+1,
          failure_code=$5, failure_message=$6, updated_at=clock_timestamp()
      FROM publications p
      WHERE s.run_id=$1 AND s.connector_id=$2 AND s.step_key=$3 AND s.status='running'
        AND p.run_id=s.run_id AND p.connector_id=s.connector_id
        AND p.status='publishing' AND p.claim_token=$4
    `,
      [
        runId,
        this.connectorId,
        stepKey,
        token,
        error.code ?? null,
        error.message,
        options.retry === false ? 'terminal_failed' : 'failed'
      ]
    )
    return result.rowCount === 1
  }
  async completePublication(runId: string, token: string): Promise<boolean> {
    const result = await this.pool.query(
      `
      UPDATE publications
      SET status='published', claim_token=NULL, published_at=clock_timestamp(),
          failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
      WHERE run_id=$1 AND connector_id=$2
        AND status='publishing' AND claim_token=$3
        AND NOT EXISTS (
          SELECT 1 FROM publication_steps
          WHERE run_id=$1 AND connector_id=$2 AND status <> 'succeeded'
        )
    `,
      [runId, this.connectorId, token]
    )
    return result.rowCount === 1
  }
  async failPublication(
    runId: string,
    token: string,
    error: { code?: string | null; message: string },
    options: { retry: boolean }
  ): Promise<boolean> {
    // Only the current owner may spend the publication budget or write a final
    // state. A stale worker can finish its HTTP call, but it cannot commit here.
    const result = await this.pool.query(
      `
      UPDATE publications
      SET status=$4, claim_token=NULL, failure_code=$5,
          failure_message=$6, updated_at=clock_timestamp()
      WHERE run_id=$1 AND connector_id=$2
        AND status='publishing' AND claim_token=$3
    `,
      [
        runId,
        this.connectorId,
        token,
        options.retry ? 'pending' : 'failed',
        error.code ?? null,
        error.message
      ]
    )
    return result.rowCount === 1
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
