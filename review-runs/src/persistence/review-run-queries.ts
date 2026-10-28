// Owns the Review Runs read model: connector-fenced record projection, list filtering and
// pagination, coordination queues, parked work, events, and execution statistics.
import type { Pool } from 'pg'

import type { ReviewRunWorkflow as WorkflowName } from '../contracts.js'
import type {
  ExecutionStatisticsSummary,
  ExecutionStatus,
  PreparationStatus,
  PublicationStatus,
  ReviewRunEvent,
  ReviewRunRecord
} from '../shapes.js'
import { listEvents } from './review-run-events.js'
import {
  RUN_SELECT,
  rowToRecord,
  type ReviewRunRow
} from './run-record-projection.js'

/** One run the system stopped working on by itself, and the axis it is parked on. */
export interface ParkedRun {
  run_id: string
  axis: 'preparation' | 'execution' | 'publication'
  parked_at: string
  reason:
    | 'EXECUTION_ALREADY_ADVANCED'
    | 'SUBMISSION_RECOVERY_EXHAUSTED'
    | 'PUBLICATION_RECONCILIATION_EXHAUSTED'
    | null
}

/** A stored row the contract cannot represent, kept so a fan-out read can report it. */
export interface DroppedRunRow {
  run_id: string
  error: unknown
}

/** A fan-out read's result: the rows that project cleanly, and the ones that do not. */
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

export interface ListRunsOptions {
  limit?: number
  cursor?: string
  execution_status?: ExecutionStatus
  publication_status?: PublicationStatus
  preparation_status?: PreparationStatus
  source_platform?: ReviewRunRecord['source_platform']
  workflow?: WorkflowName
  from?: string
  to?: string
}

export class ReviewRunQueries {
  constructor(
    private readonly pool: Pool,
    private readonly connectorId: string,
    private readonly claimTimeoutMs: number,
    private readonly onDroppedRunRow: (dropped: DroppedRunRow) => void
  ) {}

  /** Check the trunk directly so a corrupt axis row does not hide a readable event history. */
  async runExists(runId: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM review_runs WHERE run_id=$1 AND connector_id=$2',
      [runId, this.connectorId]
    )
    return result.rowCount === 1
  }

  async listEvents(runId: string): Promise<ReviewRunEvent[]> {
    return await listEvents(this.pool, runId, this.connectorId)
  }

  async getRun(runId: string): Promise<ReviewRunRecord | null> {
    const result = await this.pool.query<ReviewRunRow>(
      `${RUN_SELECT}
      WHERE r.run_id=$1 AND r.connector_id=$2`,
      [runId, this.connectorId]
    )
    const row = result.rows[0]
    if (row === undefined) return null
    // Single-run reads cannot return a `dropped` side channel, so report corruption and preserve
    // the established nullable lookup contract.
    try {
      return rowToRecord(row)
    } catch (error) {
      this.onDroppedRunRow({ run_id: row.trunk.run_id, error })
      return null
    }
  }

  async getExecutionStatistics(
    runIds: readonly string[]
  ): Promise<Map<string, ExecutionStatisticsSummary>> {
    if (runIds.length === 0) return new Map()
    const result = await this.pool.query<{
      run_id: string
      statistics: ExecutionStatisticsSummary
    }>(
      `SELECT s.run_id,
        json_build_object(
          'reconciliation_status', s.status,
          'ingestion_status', s.ingestion_status,
          'usage_coverage', s.usage_coverage,
          'root_trace_count', s.root_trace_count,
          'excluded_non_review_root_count', s.excluded_non_review_root_count,
          'observed_call_count', s.observed_call_count,
          'usage_reported_call_count', s.usage_reported_call_count,
          'token_usage', json_build_object(
            'input_tokens', s.input_tokens,
            'output_tokens', s.output_tokens,
            'total_tokens', s.total_tokens,
            'cache_read_input_tokens', s.cache_read_input_tokens,
            'cache_creation_input_tokens', s.cache_creation_input_tokens,
            'reasoning_tokens', s.reasoning_tokens
          ),
          'groups', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'agent_name', g.agent_name,
              'case_id', g.case_id,
              'delivery_id', g.delivery_id,
              'pass_kind', g.pass_kind,
              'pass_index', g.pass_index,
              'batch_index', g.batch_index,
              'chunk_id', g.chunk_id,
              'provider', g.provider,
              'model', g.model,
              'model_call_count', g.model_call_count,
              'usage_reported_call_count', g.usage_reported_call_count,
              'token_usage', jsonb_build_object(
                'input_tokens', g.input_tokens,
                'output_tokens', g.output_tokens,
                'total_tokens', g.total_tokens,
                'cache_read_input_tokens', g.cache_read_input_tokens,
                'cache_creation_input_tokens', g.cache_creation_input_tokens,
                'reasoning_tokens', g.reasoning_tokens
              )
            ) ORDER BY g.case_id NULLS FIRST,g.delivery_id NULLS FIRST,
              g.pass_index NULLS FIRST,g.batch_index NULLS FIRST,g.chunk_id NULLS FIRST,
              g.agent_name,g.provider,g.model NULLS FIRST)
            FROM execution_statistics_groups g WHERE g.run_id=s.run_id
          ), '[]'::jsonb),
          'settled_at', s.settled_at,
          'updated_at', s.updated_at
        ) AS statistics
       FROM execution_statistics s
       JOIN review_runs r ON r.run_id=s.run_id
       WHERE r.connector_id=$1 AND s.run_id=ANY($2::text[])`,
      [this.connectorId, runIds]
    )
    return new Map(
      result.rows.map(({ run_id, statistics }) => [run_id, statistics])
    )
  }

  private async listRunRows(
    options: ListRunsOptions,
    limit: number
  ): Promise<ReviewRunRow[]> {
    const values: unknown[] = [this.connectorId]
    const clauses = ['r.connector_id=$1']
    const add = (value: unknown): string => {
      values.push(value)
      return `$${values.length}`
    }
    if (options.workflow !== undefined)
      clauses.push(`r.workflow=${add(options.workflow)}`)
    if (options.source_platform !== undefined)
      clauses.push(`r.source_platform=${add(options.source_platform)}`)
    // Missing LEFT JOINed axes are corruption and must remain visible to projection even when a
    // status filter is present.
    if (options.execution_status !== undefined) {
      const status = add(options.execution_status)
      clauses.push(`(e.status=${status} OR e.run_id IS NULL)`)
    }
    if (options.publication_status !== undefined)
      clauses.push(`p.status=${add(options.publication_status)}`)
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
    // The cursor and ordering share the same full-precision timestamp and run-id tie breaker.
    const result = await this.pool.query<ReviewRunRow>(
      `${RUN_SELECT}
      WHERE ${clauses.join(' AND ')} ORDER BY r.created_at DESC, r.run_id DESC LIMIT ${add(limit)}`,
      values
    )
    return result.rows
  }

  async listRunsPage(options: ListRunsOptions = {}): Promise<{
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

  async listParkedRuns(): Promise<ParkedRun[]> {
    const result = await this.pool.query<ParkedRun>(
      `SELECT run_id, axis, reason, parked_at FROM (
         SELECT run_id, 'preparation' AS axis, disconnect_reason AS reason,
           COALESCE((
             SELECT e.occurred_at FROM review_run_events e
             WHERE e.run_id = preparations.run_id
               AND e.connector_id = preparations.connector_id
               AND e.axis = 'preparation'
               AND e.to_status = 'disconnected'
             ORDER BY e.occurred_at DESC LIMIT 1
           ), updated_at) AS parked_at
         FROM preparations
         WHERE connector_id=$1 AND status='disconnected'
         UNION ALL
         SELECT run_id, 'execution' AS axis, 'SUBMISSION_RECOVERY_EXHAUSTED' AS reason,
           COALESCE((
             SELECT e.occurred_at FROM review_run_events e
             WHERE e.run_id = executions.run_id
               AND e.connector_id = executions.connector_id
               AND e.axis = 'execution'
               AND e.to_status = 'disconnected'
             ORDER BY e.occurred_at DESC LIMIT 1
           ), updated_at) AS parked_at
         FROM executions
         WHERE connector_id=$1 AND status='disconnected'
         UNION ALL
         SELECT run_id, 'publication' AS axis, 'PUBLICATION_RECONCILIATION_EXHAUSTED' AS reason,
           COALESCE((
             SELECT e.occurred_at FROM review_run_events e
             WHERE e.run_id = publications.run_id
               AND e.connector_id = publications.connector_id
               AND e.axis = 'publication'
               AND e.to_status = 'disconnected'
             ORDER BY e.occurred_at DESC LIMIT 1
           ), updated_at) AS parked_at
         FROM publications
         WHERE connector_id=$1 AND status='disconnected'
       ) parked
       ORDER BY parked_at, run_id`,
      [this.connectorId]
    )
    return result.rows
  }

  async listSubmissionRecoveries(): Promise<RunRowsProjection> {
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
}
