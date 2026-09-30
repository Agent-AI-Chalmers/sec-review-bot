import Database from 'better-sqlite3'
import crypto from 'node:crypto'
import fs from 'fs'
import path from 'path'

import { review_run_state_db_path } from '../../config.js'
import type { WorkflowName } from './client.js'

type JsonObject = Record<string, unknown>

export type ReviewRunStatus =
  // The request was accepted, but its workspace and Runner input are still being prepared. There is nothing to poll yet.
  | 'preparing'
  // A publisher has exclusively claimed an uncertain Runner submission and is resolving it.
  | 'recovering'
  // The Runner accepted the run, but the integration has not observed it running yet.
  | 'queued'
  // The Runner or Temporal is executing the review workflow.
  | 'running'
  // The Runner finished successfully, and the integration is publishing the required GitHub output.
  | 'publishing'
  // Every required GitHub publish step completed. This is the successful final state.
  | 'published'
  // Input preparation, Runner submission or execution, or result validation failed. This is a final state.
  | 'failed'
  // The Runner result is valid, but GitHub publishing failed. The publisher may retry while attempts remain.
  | 'publish_failed'

export interface CreateReviewRunArgs {
  run_id: string
  workflow: WorkflowName
  publish_context: JsonObject
  runner_input?: JsonObject
  ingress_kind?: 'github_webhook' | 'github_actions_dispatch'
  ingress_key?: string
}

export interface ReviewRunAdmission {
  record: ReviewRunRecord
  created: boolean
}

export interface ReviewRunRecord extends CreateReviewRunArgs {
  status: ReviewRunStatus
  created_at: string
  updated_at: string
  published_at: string | null
  // Counts failed GitHub publishes, not publisher claims.
  publish_attempts: number
  failure_code: string | null
  failure_message: string | null
}

export interface ReviewRunDiagnosticRecord extends ReviewRunRecord {
  is_active: boolean
  is_terminal: boolean
  retry_exhausted: boolean
  publish_attempts_remaining: number
}

export interface ReviewRunDiagnosticsOptions {
  limit?: number
  status?: ReviewRunStatus
  active_only?: boolean
  failed_only?: boolean
}

interface ReviewRunRow {
  run_id: string
  workflow: WorkflowName
  publish_context_json: string
  runner_input_json: string | null
  recovery_claim_token: string | null
  status: ReviewRunStatus
  created_at: string
  updated_at: string
  published_at: string | null
  publish_attempts: number
  failure_code: string | null
  failure_message: string | null
  ingress_kind: 'github_webhook' | 'github_actions_dispatch' | null
  ingress_key: string | null
}

const MAX_PUBLISH_ATTEMPTS = 3
const DEFAULT_PUBLISHING_CLAIM_TIMEOUT_MS = 10 * 60 * 1000
const REVIEW_RUN_STORE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS review_runs (
        run_id TEXT PRIMARY KEY,
        workflow TEXT NOT NULL,
        publish_context_json TEXT NOT NULL,
        runner_input_json TEXT,
        recovery_claim_token TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    published_at TEXT,
    publish_attempts INTEGER NOT NULL DEFAULT 0,
    failure_code TEXT,
    failure_message TEXT,
    ingress_kind TEXT,
    ingress_key TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_review_runs_status
    ON review_runs (status, updated_at);
`

const REVIEW_RUN_INGRESS_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_review_runs_ingress
    ON review_runs (ingress_kind, ingress_key)
    WHERE ingress_kind IS NOT NULL AND ingress_key IS NOT NULL;
`

function nowIso (): string {
  return new Date().toISOString()
}

function isIngressUniqueConstraintError (error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE'
}

function positiveIntegerOrDefault (value: number | undefined, default_value: number): number {
  return Number.isFinite(value) && typeof value === 'number' && value >= 0
    ? Math.floor(value)
    : default_value
}

function parseJsonObject (raw: string, label: string): JsonObject {
  const parsed = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Runner run store has invalid ${label}.`)
  }
  return parsed as JsonObject
}

function rowToRecord (row: ReviewRunRow): ReviewRunRecord {
  return {
    run_id: row.run_id,
    workflow: row.workflow,
    publish_context: parseJsonObject(row.publish_context_json, 'publish_context_json'),
    ...(row.runner_input_json === null
      ? {}
      : { runner_input: parseJsonObject(row.runner_input_json, 'runner_input_json') }),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_at: row.published_at,
    publish_attempts: row.publish_attempts,
    failure_code: row.failure_code,
    failure_message: row.failure_message,
    ...(row.ingress_kind ? { ingress_kind: row.ingress_kind } : {}),
    ...(row.ingress_key ? { ingress_key: row.ingress_key } : {})
  }
}

function publishAttemptsRemaining (record: ReviewRunRecord): number {
  return Math.max(0, MAX_PUBLISH_ATTEMPTS - record.publish_attempts)
}

function isActiveRecord (record: ReviewRunRecord): boolean {
  return ['recovering', 'queued', 'running', 'publishing'].includes(record.status) ||
    (record.status === 'failed' && record.failure_code === 'SUBMISSION_STATE_UNCERTAIN') ||
    (record.status === 'publish_failed' && publishAttemptsRemaining(record) > 0)
}

function isRetryExhaustedRecord (record: ReviewRunRecord): boolean {
  return record.status === 'publish_failed' && publishAttemptsRemaining(record) === 0
}

function recordToDiagnosticRecord (record: ReviewRunRecord): ReviewRunDiagnosticRecord {
  const retry_exhausted = isRetryExhaustedRecord(record)
  return {
    ...record,
    is_active: isActiveRecord(record),
    is_terminal: record.status === 'published' ||
      (record.status === 'failed' && record.failure_code !== 'SUBMISSION_STATE_UNCERTAIN') ||
      retry_exhausted,
    retry_exhausted,
    publish_attempts_remaining: publishAttemptsRemaining(record)
  }
}

export class ReviewRunStore {
  private readonly db: Database.Database
  private readonly publishingClaimTimeoutMs: number

  constructor (dbPath: string, options: { publishingClaimTimeoutMs?: number } = {}) {
    this.publishingClaimTimeoutMs = positiveIntegerOrDefault(
      options.publishingClaimTimeoutMs,
      DEFAULT_PUBLISHING_CLAIM_TIMEOUT_MS
    )
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(REVIEW_RUN_STORE_SCHEMA)
    let columns = this.db.pragma('table_info(review_runs)') as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'ingress_kind')) {
      // review_runs is intentionally an internal, destructive schema. An old
      // local table cannot represent ingress identity, so do not reinterpret it.
      this.db.exec('DROP TABLE review_runs;')
      this.db.exec(REVIEW_RUN_STORE_SCHEMA)
      columns = this.db.pragma('table_info(review_runs)') as Array<{ name: string }>
    }
    if (!columns.some((column) => column.name === 'runner_input_json')) {
      // Prepared Runner input is additive recovery data. Preserve existing
      // runs; only legacy uncertain submissions will lack enough data to retry.
      this.db.exec('ALTER TABLE review_runs ADD COLUMN runner_input_json TEXT;')
    }
    if (!columns.some((column) => column.name === 'recovery_claim_token')) {
      // The token fences a worker whose stale recovery claim was taken over.
      this.db.exec('ALTER TABLE review_runs ADD COLUMN recovery_claim_token TEXT;')
    }
    this.db.exec(REVIEW_RUN_INGRESS_INDEX)
    this.failInterruptedPreparations()
  }

  /** Create the durable review record before workspace/input preparation starts. */
  create_preparing_review_run (run: CreateReviewRunArgs): ReviewRunRecord {
    return this.insert_preparing_review_run(run)
  }

  /** Atomically accepts a new ingress request or returns the run already accepted for that request. */
  admit_review_run (run: CreateReviewRunArgs & Required<Pick<CreateReviewRunArgs, 'ingress_kind' | 'ingress_key'>>): ReviewRunAdmission {
    try {
      return this.db.transaction(() => {
        const existing = this.db.prepare(`
          SELECT * FROM review_runs WHERE ingress_kind = ? AND ingress_key = ?
        `).get(run.ingress_kind, run.ingress_key) as ReviewRunRow | undefined
        if (existing) {
          const reclaimed = this.reclaimRecoverableAdmission(existing)
          return reclaimed ?? {
            record: rowToRecord(existing),
            created: false
          }
        }

        const record = this.insert_preparing_review_run(run)
        return { record, created: true }
      })()
    } catch (error) {
      if (!isIngressUniqueConstraintError(error)) {
        throw error
      }
      // The transaction prevents a check-then-insert race. If another SQLite
      // connection won the ingress unique constraint, read its durable record.
      const concurrent = this.db.prepare(`
        SELECT * FROM review_runs WHERE ingress_kind = ? AND ingress_key = ?
      `).get(run.ingress_kind, run.ingress_key) as ReviewRunRow | undefined
      if (concurrent) return { record: rowToRecord(concurrent), created: false }
      throw error
    }
  }

  private insert_preparing_review_run (run: CreateReviewRunArgs): ReviewRunRecord {
    const timestamp = nowIso()
    this.db.prepare(`
      INSERT INTO review_runs (
        run_id, workflow, publish_context_json, runner_input_json, status, created_at, updated_at,
        published_at, publish_attempts, failure_code, failure_message, ingress_kind, ingress_key
      ) VALUES (?, ?, ?, ?, 'preparing', ?, ?, NULL, 0, NULL, NULL, ?, ?)
    `).run(
      run.run_id,
      run.workflow,
      JSON.stringify(run.publish_context),
      run.runner_input === undefined ? null : JSON.stringify(run.runner_input),
      timestamp,
      timestamp,
      run.ingress_kind ?? null,
      run.ingress_key ?? null
    )
    const record = this.getRun(run.run_id)
    if (record === null) {
      throw new Error(`Runner run was not persisted: ${run.run_id}`)
    }
    return record
  }

  private failInterruptedPreparations (): void {
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE review_runs
      SET status = 'failed',
          updated_at = ?,
          failure_code = 'PREPARATION_INTERRUPTED',
          failure_message = 'The integration stopped before Runner submission was durably recorded.'
      WHERE status = 'preparing'
    `).run(timestamp)
  }

  private reclaimRecoverableAdmission (existing: ReviewRunRow): ReviewRunAdmission | null {
    // An interrupted preparation is known not to have crossed the Runner POST
    // boundary. Submission uncertainty needs the separate Runner lookup path.
    if (existing.status !== 'failed' || existing.failure_code !== 'PREPARATION_INTERRUPTED') {
      return null
    }
    const result = this.db.prepare(`
      UPDATE review_runs
      SET status = 'preparing',
          updated_at = ?,
          failure_code = NULL,
          failure_message = NULL
      WHERE run_id = ? AND status = 'failed' AND failure_code = ?
    `).run(nowIso(), existing.run_id, existing.failure_code)
    if (result.changes !== 1) {
      return null
    }
    const record = this.getRun(existing.run_id)
    if (record === null) {
      throw new Error(`Reclaimed review run was not found: ${existing.run_id}`)
    }
    return { record, created: true }
  }

  /** Save everything needed to recover before submission crosses the uncertain HTTP boundary. */
  save_prepared_submission (run_id: string, publish_context: JsonObject, runner_input: JsonObject): void {
    const result = this.db.prepare(`
      UPDATE review_runs
      SET publish_context_json = ?, runner_input_json = ?, updated_at = ?
      WHERE run_id = ? AND status = 'preparing'
    `).run(JSON.stringify(publish_context), JSON.stringify(runner_input), nowIso(), run_id)
    if (result.changes !== 1) {
      throw new Error(`Review run ${run_id} cannot save prepared submission outside preparing.`)
    }
  }

  listSubmissionRecoveries (): ReviewRunRecord[] {
    const staleClaimBefore = new Date(Date.now() - this.publishingClaimTimeoutMs).toISOString()
    const rows = this.db.prepare(`
      SELECT * FROM review_runs
      WHERE (status = 'failed' AND failure_code = 'SUBMISSION_STATE_UNCERTAIN')
         OR (status = 'recovering' AND updated_at <= ?)
      ORDER BY updated_at ASC
    `).all(staleClaimBefore) as ReviewRunRow[]
    return rows.map(rowToRecord)
  }

  /** Exclusively claim an uncertain submission before making a Runner request. */
  claimSubmissionRecovery (run_id: string): string | null {
    const timestamp = nowIso()
    const claimToken = crypto.randomUUID()
    const staleClaimBefore = new Date(Date.now() - this.publishingClaimTimeoutMs).toISOString()
    const result = this.db.prepare(`
      UPDATE review_runs
      SET status = 'recovering', updated_at = ?, recovery_claim_token = ?
      WHERE run_id = ? AND (
        (status = 'failed' AND failure_code = 'SUBMISSION_STATE_UNCERTAIN')
        OR (status = 'recovering' AND updated_at <= ?)
      )
    `).run(timestamp, claimToken, run_id, staleClaimBefore)
    return result.changes === 1 ? claimToken : null
  }

  /** Resume normal polling after recovery confirms or recreates the Runner run. */
  completeSubmissionRecovery (run_id: string, claim_token: string): boolean {
    const result = this.db.prepare(`
      UPDATE review_runs
      SET status = 'queued', updated_at = ?, failure_code = NULL, failure_message = NULL,
          recovery_claim_token = NULL
      WHERE run_id = ? AND status = 'recovering' AND recovery_claim_token = ?
    `).run(nowIso(), run_id, claim_token)
    return result.changes === 1
  }

  /** Finish or defer recovery only while this worker still owns the claim. */
  failSubmissionRecovery (
    run_id: string,
    claim_token: string,
    error: { code?: string | null, message: string }
  ): boolean {
    const result = this.db.prepare(`
      UPDATE review_runs
      SET status = 'failed', updated_at = ?, failure_code = ?, failure_message = ?,
          recovery_claim_token = NULL
      WHERE run_id = ? AND status = 'recovering' AND recovery_claim_token = ?
    `).run(nowIso(), error.code ?? null, error.message, run_id, claim_token)
    return result.changes === 1
  }

  /** Store the completed publish context and make the run visible to the poller. */
  mark_queued (run_id: string, publish_context: JsonObject): void {
    const result = this.db.prepare(`
      UPDATE review_runs
      SET publish_context_json = ?, status = 'queued', updated_at = ?, failure_code = NULL, failure_message = NULL
      WHERE run_id = ? AND status = 'preparing'
    `).run(JSON.stringify(publish_context), nowIso(), run_id)
    if (result.changes !== 1) {
      throw new Error(`Review run ${run_id} cannot transition from preparing to queued.`)
    }
  }

  getRun (run_id: string): ReviewRunRecord | null {
    const row = this.db.prepare('SELECT * FROM review_runs WHERE run_id = ?').get(run_id) as ReviewRunRow | undefined
    return row ? rowToRecord(row) : null
  }

  listActiveRuns (): ReviewRunRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM review_runs
      WHERE status IN ('queued', 'running', 'publishing')
         -- Permanent GitHub publication rejects should not spin forever in the background publisher.
         OR (status = 'publish_failed' AND publish_attempts < ?)
      ORDER BY updated_at ASC
    `).all(MAX_PUBLISH_ATTEMPTS) as ReviewRunRow[]
    return rows.map(rowToRecord)
  }

  listRunsForDiagnostics (options: ReviewRunDiagnosticsOptions = {}): ReviewRunDiagnosticRecord[] {
    const limit = Math.max(1, positiveIntegerOrDefault(options.limit, 50))
    const clauses: string[] = []
    const params: unknown[] = []
    // Filters compose with AND so operators can narrow diagnostics precisely.
    if (options.status !== undefined) {
      clauses.push('status = ?')
      params.push(options.status)
    }
    if (options.active_only === true) {
      clauses.push(`(
        status IN ('recovering', 'queued', 'running', 'publishing')
        OR (status = 'failed' AND failure_code = 'SUBMISSION_STATE_UNCERTAIN')
        OR (status = 'publish_failed' AND publish_attempts < ?)
      )`)
      params.push(MAX_PUBLISH_ATTEMPTS)
    }
    if (options.failed_only === true) {
      clauses.push("status IN ('failed', 'publish_failed')")
    }
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`
      SELECT *
      FROM review_runs
      ${whereClause}
      ORDER BY updated_at DESC, created_at DESC, run_id ASC
      LIMIT ?
    `).all(...params, limit) as ReviewRunRow[]
    return rows.map(rowToRecord).map(recordToDiagnosticRecord)
  }

  markRunning (run_id: string): void {
    this.markStatus(run_id, 'running')
  }

  markPublishing (run_id: string): boolean {
    const timestamp = nowIso()
    const stalePublishingBefore = new Date(Date.now() - this.publishingClaimTimeoutMs).toISOString()
    // Claim publication atomically to avoid duplicate GitHub side effects.
    // A stale in-flight publish can be reclaimed without spending a retry;
    // only a recorded publish failure increments publish_attempts.
    const result = this.db.prepare(`
      UPDATE review_runs
      SET status = 'publishing',
          updated_at = ?,
          failure_code = NULL,
          failure_message = NULL
      WHERE run_id = ?
        AND (
          status IN ('queued', 'running')
          OR (status = 'publish_failed' AND publish_attempts < ?)
          OR (status = 'publishing' AND updated_at <= ? AND publish_attempts < ?)
        )
    `).run(timestamp, run_id, MAX_PUBLISH_ATTEMPTS, stalePublishingBefore, MAX_PUBLISH_ATTEMPTS)
    return result.changes === 1
  }

  markPublished (run_id: string): void {
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE review_runs
      SET status = 'published',
          updated_at = ?,
          published_at = ?,
          failure_code = NULL,
          failure_message = NULL
      WHERE run_id = ?
    `).run(timestamp, timestamp, run_id)
  }

  markFailed (run_id: string, error: { code?: string | null, message: string }): void {
    this.markFailure(run_id, 'failed', error)
  }

  markPublishFailed (run_id: string, error: { code?: string | null, message: string }): void {
    this.markFailure(run_id, 'publish_failed', error)
  }

  close (): void {
    if (this.db.open) {
      this.db.close()
    }
  }

  private markStatus (run_id: string, status: ReviewRunStatus): void {
    this.db.prepare(`
      UPDATE review_runs
      SET status = ?,
          updated_at = ?
      WHERE run_id = ?
    `).run(status, nowIso(), run_id)
  }

  private markFailure (run_id: string, status: ReviewRunStatus, error: { code?: string | null, message: string }): void {
    // publish_attempts means "failed GitHub publishes", so deterministic runner
    // failures move to failed without consuming the GitHub publish retry budget.
    this.db.prepare(`
      UPDATE review_runs
      SET status = ?,
          updated_at = ?,
          publish_attempts = CASE
            WHEN ? = 'publish_failed' THEN publish_attempts + 1
            ELSE publish_attempts
          END,
          failure_code = ?,
          failure_message = ?
      WHERE run_id = ?
    `).run(status, nowIso(), status, error.code ?? null, error.message, run_id)
  }
}

export const reviewRunStore = new ReviewRunStore(review_run_state_db_path)
