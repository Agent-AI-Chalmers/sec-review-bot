import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

import { runner_run_state_db_path } from '../../config.js'
import type { WorkflowName } from './client.js'

type JsonObject = Record<string, unknown>

export type RunnerRunStatus =
  | 'queued'
  | 'running'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'publish_failed'

export interface SaveRunnerRunArgs {
  run_id: string
  workflow: WorkflowName
  publish_context: JsonObject
}

export interface RunnerRunRecord extends SaveRunnerRunArgs {
  status: RunnerRunStatus
  created_at: string
  updated_at: string
  published_at: string | null
  // Counts failed GitHub publishes, not publisher claims.
  publish_attempts: number
  failure_code: string | null
  failure_message: string | null
}

export interface RunnerRunDiagnosticRecord extends RunnerRunRecord {
  is_active: boolean
  is_terminal: boolean
  retry_exhausted: boolean
  publish_attempts_remaining: number
}

export interface RunnerRunDiagnosticsOptions {
  limit?: number
  status?: RunnerRunStatus
  active_only?: boolean
  failed_only?: boolean
}

interface RunnerRunRow {
  run_id: string
  workflow: WorkflowName
  publish_context_json: string
  status: RunnerRunStatus
  created_at: string
  updated_at: string
  published_at: string | null
  publish_attempts: number
  failure_code: string | null
  failure_message: string | null
}

const MAX_PUBLISH_ATTEMPTS = 3
const DEFAULT_PUBLISHING_CLAIM_TIMEOUT_MS = 10 * 60 * 1000

const RUNNER_RUN_STORE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS runner_runs (
    run_id TEXT PRIMARY KEY,
    workflow TEXT NOT NULL,
    publish_context_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    published_at TEXT,
    publish_attempts INTEGER NOT NULL DEFAULT 0,
    failure_code TEXT,
    failure_message TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_runner_runs_status
    ON runner_runs (status, updated_at);
`

function nowIso (): string {
  return new Date().toISOString()
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

function rowToRecord (row: RunnerRunRow): RunnerRunRecord {
  return {
    run_id: row.run_id,
    workflow: row.workflow,
    publish_context: parseJsonObject(row.publish_context_json, 'publish_context_json'),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_at: row.published_at,
    publish_attempts: row.publish_attempts,
    failure_code: row.failure_code,
    failure_message: row.failure_message
  }
}

function publishAttemptsRemaining (record: RunnerRunRecord): number {
  return Math.max(0, MAX_PUBLISH_ATTEMPTS - record.publish_attempts)
}

function isActiveRecord (record: RunnerRunRecord): boolean {
  return ['queued', 'running', 'publishing'].includes(record.status) ||
    (record.status === 'publish_failed' && publishAttemptsRemaining(record) > 0)
}

function isRetryExhaustedRecord (record: RunnerRunRecord): boolean {
  return record.status === 'publish_failed' && publishAttemptsRemaining(record) === 0
}

function recordToDiagnosticRecord (record: RunnerRunRecord): RunnerRunDiagnosticRecord {
  const retry_exhausted = isRetryExhaustedRecord(record)
  return {
    ...record,
    is_active: isActiveRecord(record),
    is_terminal: record.status === 'published' || record.status === 'failed' || retry_exhausted,
    retry_exhausted,
    publish_attempts_remaining: publishAttemptsRemaining(record)
  }
}

export class RunnerRunStore {
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
    this.db.exec(RUNNER_RUN_STORE_SCHEMA)
  }

  save_queued_run (run: SaveRunnerRunArgs): RunnerRunRecord {
    const timestamp = nowIso()
    this.db.prepare(`
      INSERT INTO runner_runs (
        run_id,
        workflow,
        publish_context_json,
        status,
        created_at,
        updated_at,
        published_at,
        publish_attempts,
        failure_code,
        failure_message
      )
      VALUES (?, ?, ?, 'queued', ?, ?, NULL, 0, NULL, NULL)
      ON CONFLICT(run_id) DO UPDATE SET
        workflow = excluded.workflow,
        publish_context_json = excluded.publish_context_json,
        status = 'queued',
        updated_at = excluded.updated_at,
        published_at = NULL,
        publish_attempts = 0,
        failure_code = NULL,
        failure_message = NULL
    `).run(
      run.run_id,
      run.workflow,
      JSON.stringify(run.publish_context),
      timestamp,
      timestamp
    )

    const record = this.getRun(run.run_id)
    if (record === null) {
      throw new Error(`Runner run was not persisted: ${run.run_id}`)
    }
    return record
  }

  getRun (run_id: string): RunnerRunRecord | null {
    const row = this.db.prepare('SELECT * FROM runner_runs WHERE run_id = ?').get(run_id) as RunnerRunRow | undefined
    return row ? rowToRecord(row) : null
  }

  listActiveRuns (): RunnerRunRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM runner_runs
      WHERE status IN ('queued', 'running', 'publishing')
         -- Permanent GitHub publication rejects should not spin forever in the background publisher.
         OR (status = 'publish_failed' AND publish_attempts < ?)
      ORDER BY updated_at ASC
    `).all(MAX_PUBLISH_ATTEMPTS) as RunnerRunRow[]
    return rows.map(rowToRecord)
  }

  listRunsForDiagnostics (options: RunnerRunDiagnosticsOptions = {}): RunnerRunDiagnosticRecord[] {
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
        status IN ('queued', 'running', 'publishing')
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
      FROM runner_runs
      ${whereClause}
      ORDER BY updated_at DESC, created_at DESC, run_id ASC
      LIMIT ?
    `).all(...params, limit) as RunnerRunRow[]
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
      UPDATE runner_runs
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
      UPDATE runner_runs
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

  private markStatus (run_id: string, status: RunnerRunStatus): void {
    this.db.prepare(`
      UPDATE runner_runs
      SET status = ?,
          updated_at = ?
      WHERE run_id = ?
    `).run(status, nowIso(), run_id)
  }

  private markFailure (run_id: string, status: RunnerRunStatus, error: { code?: string | null, message: string }): void {
    // publish_attempts means "failed GitHub publishes", so deterministic runner
    // failures move to failed without consuming the GitHub publish retry budget.
    this.db.prepare(`
      UPDATE runner_runs
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

export const runnerRunStore = new RunnerRunStore(runner_run_state_db_path)
