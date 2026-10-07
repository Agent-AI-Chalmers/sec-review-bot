import crypto from 'node:crypto'
import { Pool, type PoolClient, type PoolConfig } from 'pg'

import type { ControlPlaneWorkflow as WorkflowName, RunnerArtifactPublication } from './contracts.js'
import { applySchemaVersions } from './database/schema-version-runner.js'
import { DeterministicControlPlaneError } from './errors.js'

type JsonObject = Record<string, unknown>
export type PublishContext = JsonObject
export type PublishContextValidator = (workflow: WorkflowName, context: JsonObject) => PublishContext
export type ReviewRunStatus = 'preparing' | 'recovering' | 'queued' | 'running' | 'publishing' | 'published' | 'failed'
type RunnerStatus = 'preparing' | 'recovering' | 'queued' | 'running' | 'failed'
type PublicationStatus = 'pending' | 'publishing' | 'published' | 'failed' | 'not_required'

export interface CreateReviewRunArgs {
  run_id: string
  workflow: WorkflowName
  publish_context: JsonObject
  runner_input?: JsonObject
  ingress_kind?: 'github_webhook' | 'github_actions_dispatch'
  ingress_key?: string
}
export interface ReviewRunAdmission { record: ReviewRunRecord, created: boolean, preparation_token: string | null }
export interface ReviewRunRecord extends CreateReviewRunArgs {
  status: ReviewRunStatus
  created_at: string
  updated_at: string
  published_at: string | null
  failure_code: string | null
  failure_message: string | null
  artifact_publication: RunnerArtifactPublication | null
}
export interface PublicationStepRecord {
  step_key: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'terminal_failed'
  attempts: number
  remote_object_id: string | null
  remote_object_url: string | null
  failure_code: string | null
  failure_message: string | null
}

interface ReviewRunRow {
  run_id: string
  workflow: WorkflowName
  publish_context: JsonObject
  runner_input: JsonObject | null
  runner_status: RunnerStatus
  runner_failure_code: string | null
  runner_failure_message: string | null
  artifact_publication: RunnerArtifactPublication | null
  publication_status: PublicationStatus
  created_at: Date | string
  runner_updated_at: Date | string
  publication_updated_at: Date | string
  published_at: Date | string | null
  publication_failure_code: string | null
  publication_failure_message: string | null
  ingress_kind: 'github_webhook' | 'github_actions_dispatch' | null
  ingress_key: string | null
}

const MAX_PUBLISH_ATTEMPTS = 3
const DEFAULT_CLAIM_TIMEOUT_MS = 10 * 60 * 1000
const RUN_SELECT = `
  SELECT r.run_id, r.workflow, r.publish_context, r.runner_input, r.runner_status,
    r.runner_failure_code, r.runner_failure_message, r.artifact_publication,
    r.ingress_kind, r.ingress_key,
    r.created_at, r.updated_at AS runner_updated_at,
    p.status AS publication_status, p.updated_at AS publication_updated_at,
    p.published_at,
    p.failure_code AS publication_failure_code, p.failure_message AS publication_failure_message
  FROM review_runs r JOIN publications p ON p.run_id = r.run_id
`

function iso (value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString() }
function statusOf (row: ReviewRunRow): ReviewRunStatus {
  return row.publication_status === 'pending' || row.publication_status === 'not_required'
    ? row.runner_status
    : row.publication_status
}
function rowToRecord (row: ReviewRunRow): ReviewRunRecord {
  const status = statusOf(row)
  const publicationFailure = row.publication_status === 'failed'
  return {
    run_id: row.run_id, workflow: row.workflow, publish_context: row.publish_context,
    ...(row.runner_input === null ? {} : { runner_input: row.runner_input }),
    status, created_at: iso(row.created_at),
    updated_at: iso(row.publication_status === 'pending' ? row.runner_updated_at : row.publication_updated_at),
    published_at: row.published_at === null ? null : iso(row.published_at),
    failure_code: publicationFailure ? row.publication_failure_code : row.runner_failure_code,
    failure_message: publicationFailure ? row.publication_failure_message : row.runner_failure_message,
    artifact_publication: row.artifact_publication,
    ...(row.ingress_kind ? { ingress_kind: row.ingress_kind } : {}),
    ...(row.ingress_key ? { ingress_key: row.ingress_key } : {})
  }
}
async function transaction<T> (pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

export class ReviewRunStore {
  private readonly pool: Pool
  private readonly connectorId: string
  private readonly claimTimeoutMs: number
  private readonly validatePublishContext: PublishContextValidator
  private initialized = false

  constructor ({ connectionString, connectorId = process.env.CONNECTOR_ID?.trim() || 'github-app:default', claimTimeoutMs = DEFAULT_CLAIM_TIMEOUT_MS, pool, poolConfig, validatePublishContext = (_workflow, context) => context }:
  { connectionString?: string, connectorId?: string, claimTimeoutMs?: number, pool?: Pool, poolConfig?: PoolConfig, validatePublishContext?: PublishContextValidator } = {}) {
    this.pool = pool ?? new Pool(connectionString ? { connectionString } : poolConfig)
    this.connectorId = connectorId
    this.claimTimeoutMs = Math.max(0, claimTimeoutMs)
    this.validatePublishContext = validatePublishContext
  }

  /** Exposes the coordination domain for logs without making it part of the public run contract. */
  get connector_id (): string { return this.connectorId }

  async initialize (): Promise<void> {
    if (this.initialized) return
    await applySchemaVersions(this.pool)
    this.initialized = true
  }
  private ready (): void { if (!this.initialized) throw new Error('ReviewRunStore.initialize() must complete before use.') }

  private async getWith (client: PoolClient, runId: string): Promise<ReviewRunRecord | null> {
    const result = await client.query<ReviewRunRow>(`${RUN_SELECT}
      WHERE r.run_id=$1 AND r.connector_id=$2`,
    [runId, this.connectorId])
    return result.rows[0] === undefined ? null : rowToRecord(result.rows[0])
  }
  private async insertWith (client: PoolClient, run: CreateReviewRunArgs): Promise<ReviewRunAdmission> {
    const preparationToken = crypto.randomUUID()
    await client.query(`INSERT INTO review_runs
      (run_id,connector_id,workflow,publish_context,runner_input,runner_status,preparation_claim_token,preparation_claimed_at,ingress_kind,ingress_key)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,'preparing',$6,clock_timestamp(),$7,$8)`,
    [run.run_id, this.connectorId, run.workflow, JSON.stringify(run.publish_context), run.runner_input === undefined ? null : JSON.stringify(run.runner_input), preparationToken, run.ingress_kind ?? null, run.ingress_key ?? null])
    await client.query(`
      INSERT INTO publications (run_id,connector_id,status)
      VALUES ($1,$2,'pending')
    `, [run.run_id, this.connectorId])
    const record = await this.getWith(client, run.run_id)
    if (record === null) throw new Error(`Runner run was not persisted: ${run.run_id}`)
    return { record, created: true, preparation_token: preparationToken }
  }
  async create_preparing_review_run (run: CreateReviewRunArgs): Promise<ReviewRunAdmission> {
    this.ready()
    return await transaction(this.pool, async client => await this.insertWith(client, run))
  }
  async admit_review_run (run: CreateReviewRunArgs & Required<Pick<CreateReviewRunArgs, 'ingress_kind' | 'ingress_key'>>): Promise<ReviewRunAdmission> {
    this.ready()
    try {
      return await transaction(this.pool, async client => {
        const existing = await client.query<ReviewRunRow>(`${RUN_SELECT}
          WHERE r.connector_id=$1 AND r.ingress_kind=$2 AND r.ingress_key=$3
          FOR UPDATE OF r`,
        [this.connectorId, run.ingress_kind, run.ingress_key])
        const row = existing.rows[0]
        if (row === undefined) return await this.insertWith(client, run)
        if (row.runner_status === 'preparing' || (row.runner_status === 'failed' && row.runner_failure_code === 'PREPARATION_INTERRUPTED')) {
          const token = crypto.randomUUID()
          const reclaimed = await client.query(`
            UPDATE review_runs
            SET runner_status='preparing', runner_failure_code=NULL, runner_failure_message=NULL,
                preparation_claim_token=$2,
                preparation_claimed_at=clock_timestamp(),
                updated_at=clock_timestamp()
            WHERE run_id=$1
              AND (
                (runner_status='preparing' AND preparation_claimed_at <= clock_timestamp()-($3*interval '1 millisecond'))
                OR (runner_status='failed' AND runner_failure_code='PREPARATION_INTERRUPTED')
              )
          `, [row.run_id, token, this.claimTimeoutMs])
          if (reclaimed.rowCount !== 1) return { record: rowToRecord(row), created: false, preparation_token: null }
          await client.query(`
            UPDATE publications
            SET status='pending', claim_token=NULL, failure_code=NULL,
                failure_message=NULL, updated_at=clock_timestamp()
            WHERE run_id=$1 AND connector_id=$2 AND status='not_required'
          `, [row.run_id, this.connectorId])
          const record = await this.getWith(client, row.run_id)
          if (record === null) throw new Error(`Reclaimed review run was not found: ${row.run_id}`)
          return { record, created: true, preparation_token: token }
        }
        return { record: rowToRecord(row), created: false, preparation_token: null }
      })
    } catch (error: unknown) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')) throw error
      // A concurrent transaction won the ingress identity. Read its durable run
      // after PostgreSQL rolls back this transaction.
      const existing = await this.pool.query<ReviewRunRow>(`${RUN_SELECT}
        WHERE r.connector_id=$1 AND r.ingress_kind=$2 AND r.ingress_key=$3`,
      [this.connectorId, run.ingress_kind, run.ingress_key])
      if (existing.rows[0] === undefined) throw error
      return { record: rowToRecord(existing.rows[0]), created: false, preparation_token: null }
    }
  }
  async save_prepared_submission (runId: string, token: string, context: PublishContext, input: JsonObject): Promise<void> {
    // Revalidate at the persistence boundary even when the caller is typed.
    // Tests, future adapters, and deserialized values can bypass compile-time types.
    const run = await this.getRun(runId)
    if (run === null) throw new Error(`Review run does not exist: ${runId}`)
    const publishContext = this.validatePublishContext(run.workflow, context)
    const result = await this.pool.query(`
      UPDATE review_runs
      SET publish_context=$3::jsonb, runner_input=$4::jsonb, updated_at=clock_timestamp()
      WHERE run_id=$1 AND connector_id=$5
        AND runner_status='preparing' AND preparation_claim_token=$2
        AND workflow=$6
    `, [runId, token, JSON.stringify(publishContext), JSON.stringify(input), this.connectorId, run.workflow])
    if (result.rowCount !== 1) throw new Error(`Review run ${runId} cannot save prepared submission outside preparing.`)
  }
  async mark_queued (runId: string, token: string, context: PublishContext): Promise<void> {
    const run = await this.getRun(runId)
    if (run === null) throw new Error(`Review run does not exist: ${runId}`)
    const publishContext = this.validatePublishContext(run.workflow, context)
    const result = await this.pool.query(`
      UPDATE review_runs
      SET publish_context=$3::jsonb, runner_status='queued',
          preparation_claim_token=NULL, preparation_claimed_at=NULL,
          runner_failure_code=NULL, runner_failure_message=NULL,
          updated_at=clock_timestamp()
      WHERE run_id=$1 AND connector_id=$4
        AND runner_status='preparing' AND preparation_claim_token=$2
        AND workflow=$5
    `, [runId, token, JSON.stringify(publishContext), this.connectorId, run.workflow])
    if (result.rowCount !== 1) throw new Error(`Review run ${runId} cannot transition from preparing to queued.`)
  }
  async getRun (runId: string): Promise<ReviewRunRecord | null> {
    this.ready()
    const result = await this.pool.query<ReviewRunRow>(`${RUN_SELECT}
      WHERE r.run_id=$1 AND r.connector_id=$2`,
    [runId, this.connectorId])
    return result.rows[0] === undefined ? null : rowToRecord(result.rows[0])
  }
  async expireStalePreparations (): Promise<number> {
    return await transaction(this.pool, async client => {
      const expired = await client.query<{ run_id: string }>(`
        UPDATE review_runs
        SET runner_status='failed', preparation_claim_token=NULL,
            preparation_claimed_at=NULL, runner_failure_code='PREPARATION_INTERRUPTED',
            runner_failure_message='Review preparation did not finish before its claim expired.',
            updated_at=clock_timestamp()
        WHERE connector_id=$1 AND runner_status='preparing'
          AND preparation_claimed_at <= clock_timestamp()-($2*interval '1 millisecond')
        RETURNING run_id
      `, [this.connectorId, this.claimTimeoutMs])
      if (expired.rowCount === 0) return 0

      await client.query(`
        UPDATE publications
        SET status='not_required', claim_token=NULL,
            failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
        WHERE connector_id=$1 AND run_id=ANY($2::text[]) AND status='pending'
      `, [this.connectorId, expired.rows.map(row => row.run_id)])
      return expired.rowCount ?? 0
    })
  }
  async listSubmissionRecoveries (): Promise<ReviewRunRecord[]> {
    const result = await this.pool.query<ReviewRunRow>(`${RUN_SELECT}
      WHERE r.connector_id=$1
        AND (
          (r.runner_status='failed' AND r.runner_failure_code='SUBMISSION_STATE_UNCERTAIN')
          OR (r.runner_status='recovering' AND r.updated_at <= clock_timestamp()-($2*interval '1 millisecond'))
        )
      ORDER BY r.updated_at`,
    [this.connectorId, this.claimTimeoutMs])
    return result.rows.map(rowToRecord)
  }
  async claimSubmissionRecovery (runId: string): Promise<string | null> {
    const token = crypto.randomUUID()
    const result = await this.pool.query<{ recovery_claim_token: string }>(`
      UPDATE review_runs
      SET runner_status='recovering', recovery_claim_token=$2, updated_at=clock_timestamp()
      WHERE run_id=$1 AND connector_id=$3
        AND (
          (runner_status='failed' AND runner_failure_code='SUBMISSION_STATE_UNCERTAIN')
          OR (runner_status='recovering' AND updated_at <= clock_timestamp()-($4*interval '1 millisecond'))
        )
      RETURNING recovery_claim_token
    `, [runId, token, this.connectorId, this.claimTimeoutMs])
    return result.rows[0]?.recovery_claim_token ?? null
  }
  async completeSubmissionRecovery (runId: string, token: string): Promise<boolean> {
    return await transaction(this.pool, async client => {
      const result = await client.query(`
        UPDATE review_runs
        SET runner_status='queued', recovery_claim_token=NULL,
            runner_failure_code=NULL, runner_failure_message=NULL, updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2
          AND runner_status='recovering' AND recovery_claim_token=$3
      `, [runId, this.connectorId, token])
      if (result.rowCount !== 1) return false
      await client.query(`
        UPDATE publications
        SET status='pending', claim_token=NULL, failure_code=NULL,
            failure_message=NULL, updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2 AND status='not_required'
      `, [runId, this.connectorId])
      return true
    })
  }
  async failSubmissionRecovery (runId: string, token: string, error: { code?: string | null, message: string }): Promise<boolean> {
    return await transaction(this.pool, async client => {
      const result = await client.query(`
        UPDATE review_runs
        SET runner_status='failed', recovery_claim_token=NULL,
            runner_failure_code=$4, runner_failure_message=$5, updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2
          AND runner_status='recovering' AND recovery_claim_token=$3
      `, [runId, this.connectorId, token, error.code ?? null, error.message])
      if (result.rowCount !== 1) return false
      await client.query(`
        UPDATE publications
        SET status='not_required', claim_token=NULL,
            failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2 AND status='pending'
      `, [runId, this.connectorId])
      return true
    })
  }
  async listActiveRuns (): Promise<ReviewRunRecord[]> {
    const result = await this.pool.query<ReviewRunRow>(`${RUN_SELECT}
      WHERE r.connector_id=$1
        AND ((r.runner_status IN ('queued','running') AND p.status='pending') OR p.status='publishing')
      ORDER BY GREATEST(r.updated_at,p.updated_at)`,
    [this.connectorId])
    return result.rows.map(rowToRecord)
  }
  async markRunning (runId: string): Promise<void> {
    await this.pool.query(`
      UPDATE review_runs
      SET runner_status='running', updated_at=clock_timestamp()
      WHERE run_id=$1 AND connector_id=$2 AND runner_status='queued'
    `, [runId, this.connectorId])
  }
  async recordArtifactPublication (runId: string, publication: RunnerArtifactPublication | undefined): Promise<void> {
    if (publication === undefined) return
    await this.pool.query(`
      UPDATE review_runs
      SET artifact_publication=$3::jsonb, updated_at=clock_timestamp()
      WHERE run_id=$1 AND connector_id=$2
    `, [runId, this.connectorId, JSON.stringify(publication)])
  }
  async failRunnerExecution (runId: string, error: { code?: string | null, message: string }): Promise<boolean> {
    return await transaction(this.pool, async client => {
      const run = await client.query(`
        UPDATE review_runs
        SET runner_status='failed', runner_failure_code=$3,
            runner_failure_message=$4, updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2 AND runner_status IN ('queued','running')
      `, [runId, this.connectorId, error.code ?? null, error.message])
      if (run.rowCount !== 1) return false
      // A terminal Runner failure has no result to publish. Keep the publication
      // row only as the durable declaration that publication is not applicable.
      await client.query(`
        UPDATE publications
        SET status='not_required', claim_token=NULL,
            failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2 AND status='pending'
      `, [runId, this.connectorId])
      return true
    })
  }
  async claimPublication (runId: string): Promise<string | null> {
    const token = crypto.randomUUID()
    const result = await this.pool.query<{ claim_token: string }>(`
      UPDATE publications p
      SET status='publishing', claim_token=$2, claimed_at=clock_timestamp(),
          failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
      FROM review_runs r
      WHERE p.run_id=$1 AND p.connector_id=$3 AND r.run_id=p.run_id
        AND r.runner_status IN ('queued','running')
        AND (
          p.status='pending'
          OR (p.status='publishing' AND p.claimed_at <= clock_timestamp()-($4*interval '1 millisecond'))
        )
      RETURNING p.claim_token
    `, [runId, token, this.connectorId, this.claimTimeoutMs])
    return result.rows[0]?.claim_token ?? null
  }
  publicationHeartbeatIntervalMs (): number {
    return Math.max(100, Math.min(30_000, Math.floor(this.claimTimeoutMs / 3)))
  }
  async renewPublicationClaim (runId: string, token: string): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE publications
      SET claimed_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE run_id=$1 AND connector_id=$2
        AND status='publishing' AND claim_token=$3
    `, [runId, this.connectorId, token])
    return result.rowCount === 1
  }
  async initializePublicationSteps (runId: string, token: string, stepKeys: string[]): Promise<void> {
    const uniqueKeys = [...new Set(stepKeys)].sort()
    if (uniqueKeys.length !== stepKeys.length) throw new Error(`Publication ${runId} contains duplicate step keys.`)
    await transaction(this.pool, async client => {
      const owner = await client.query(`
        SELECT 1 FROM publications
        WHERE run_id=$1 AND connector_id=$2
          AND status='publishing' AND claim_token=$3
        FOR UPDATE
      `, [runId, this.connectorId, token])
      if (owner.rowCount !== 1) throw new Error(`Publication claim was lost before steps were initialized: ${runId}`)
      const existing = await client.query<{ step_key: string }>(`
        SELECT step_key FROM publication_steps
        WHERE run_id=$1 AND connector_id=$2
        ORDER BY step_key
      `, [runId, this.connectorId])
      if (existing.rowCount === 0) {
        for (const stepKey of uniqueKeys) {
          await client.query(`
            INSERT INTO publication_steps (connector_id,run_id,step_key,status)
            VALUES ($1,$2,$3,'pending')
          `, [this.connectorId, runId, stepKey])
        }
        return
      }
      const persisted = existing.rows.map(row => row.step_key)
      if (JSON.stringify(persisted) !== JSON.stringify(uniqueKeys)) {
        throw new Error(`Publication step set changed for run ${runId}.`)
      }
    })
  }
  async listPublicationSteps (runId: string): Promise<PublicationStepRecord[]> {
    const result = await this.pool.query<PublicationStepRecord>(`
      SELECT step_key,status,attempts,remote_object_id,remote_object_url,
             failure_code,failure_message
      FROM publication_steps
      WHERE run_id=$1 AND connector_id=$2
      ORDER BY step_key
    `, [runId, this.connectorId])
    return result.rows
  }
  private async claimPublicationStep (runId: string, token: string, stepKey: string): Promise<boolean> {
    // A running step may belong to the expired publication owner. The new
    // owner reclaims it under the new publication token, then reconciles the
    // stable remote identity before issuing another side effect.
    const result = await this.pool.query(`
      UPDATE publication_steps s
      SET status='running', updated_at=clock_timestamp()
      FROM publications p
      WHERE s.run_id=$1 AND s.connector_id=$2 AND s.step_key=$3
        AND (s.status IN ('pending','running') OR (s.status='failed' AND s.attempts<$5))
        AND p.run_id=s.run_id AND p.connector_id=s.connector_id
        AND p.status='publishing' AND p.claim_token=$4
    `, [runId, this.connectorId, stepKey, token, MAX_PUBLISH_ATTEMPTS])
    return result.rowCount === 1
  }
  async requirePublicationStepClaim (runId: string, token: string, stepKey: string): Promise<void> {
    if (await this.claimPublicationStep(runId, token, stepKey)) return

    // Retry exhaustion is a persisted step outcome, not merely an exception
    // observed by one publisher. The current publication owner records it once.
    await this.pool.query(`
      UPDATE publication_steps s
      SET status='terminal_failed', updated_at=clock_timestamp()
      FROM publications p
      WHERE s.run_id=$1 AND s.connector_id=$2 AND s.step_key=$3
        AND s.status='failed' AND s.attempts>=$5
        AND p.run_id=s.run_id AND p.connector_id=s.connector_id
        AND p.status='publishing' AND p.claim_token=$4
    `, [runId, this.connectorId, stepKey, token, MAX_PUBLISH_ATTEMPTS])
    const step = (await this.listPublicationSteps(runId)).find(item => item.step_key === stepKey)
    if (step?.status === 'terminal_failed') {
      throw new DeterministicControlPlaneError(
        `Publication step exhausted its retry budget: ${stepKey}`,
        'PUBLICATION_STEP_RETRY_EXHAUSTED'
      )
    }
    throw new Error(`Publication step is not claimable: ${stepKey}`)
  }
  async completePublicationStep (runId: string, token: string, stepKey: string, remote: { id?: string | number | null, url?: string | null } = {}): Promise<boolean> {
    // A publication token fences every step commit, not only the final run
    // state. This prevents a timed-out worker from recording stale remote data.
    const result = await this.pool.query(`
      UPDATE publication_steps s
      SET status='succeeded', remote_object_id=$5, remote_object_url=$6,
          failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
      FROM publications p
      WHERE s.run_id=$1 AND s.connector_id=$2 AND s.step_key=$3 AND s.status='running'
        AND p.run_id=s.run_id AND p.connector_id=s.connector_id
        AND p.status='publishing' AND p.claim_token=$4
    `, [runId, this.connectorId, stepKey, token, remote.id == null ? null : String(remote.id), remote.url ?? null])
    return result.rowCount === 1
  }
  async failPublicationStep (runId: string, token: string, stepKey: string, error: { code?: string | null, message: string }, options: { retry?: boolean } = {}): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE publication_steps s
      SET status=$7, attempts=s.attempts+1,
          failure_code=$5, failure_message=$6, updated_at=clock_timestamp()
      FROM publications p
      WHERE s.run_id=$1 AND s.connector_id=$2 AND s.step_key=$3 AND s.status='running'
        AND p.run_id=s.run_id AND p.connector_id=s.connector_id
        AND p.status='publishing' AND p.claim_token=$4
    `, [runId, this.connectorId, stepKey, token, error.code ?? null, error.message, options.retry === false ? 'terminal_failed' : 'failed'])
    return result.rowCount === 1
  }
  async completePublication (runId: string, token: string): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE publications
      SET status='published', claim_token=NULL, published_at=clock_timestamp(),
          failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
      WHERE run_id=$1 AND connector_id=$2
        AND status='publishing' AND claim_token=$3
    `, [runId, this.connectorId, token])
    return result.rowCount === 1
  }
  async failPublication (runId: string, token: string, error: { code?: string | null, message: string }, options: { retry: boolean }): Promise<boolean> {
    // Only the current owner may spend the publication budget or write a final
    // state. A stale worker can finish its HTTP call, but it cannot commit here.
    const result = await this.pool.query(`
      UPDATE publications
      SET status=$4, claim_token=NULL, failure_code=$5,
          failure_message=$6, updated_at=clock_timestamp()
      WHERE run_id=$1 AND connector_id=$2
        AND status='publishing' AND claim_token=$3
    `, [runId, this.connectorId, token, options.retry ? 'pending' : 'failed', error.code ?? null, error.message])
    return result.rowCount === 1
  }
  async failPreparation (runId: string, token: string, error: { code?: string | null, message: string }): Promise<void> {
    await transaction(this.pool, async client => {
      const result = await client.query(`
        UPDATE review_runs
        SET runner_status='failed', preparation_claim_token=NULL,
            preparation_claimed_at=NULL, runner_failure_code=$4,
            runner_failure_message=$5, updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2
          AND runner_status='preparing' AND preparation_claim_token=$3
      `, [runId, this.connectorId, token, error.code ?? null, error.message])
      if (result.rowCount !== 1) throw new Error(`Preparation claim was lost before failing review run ${runId}.`)
      await client.query(`
        UPDATE publications
        SET status='not_required', claim_token=NULL,
            failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2 AND status='pending'
      `, [runId, this.connectorId])
    })
  }
  async close (): Promise<void> { await this.pool.end() }
}
