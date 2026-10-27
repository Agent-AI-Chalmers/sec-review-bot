import crypto from 'node:crypto'
import { Pool } from 'pg'

import type { ExecutionStatisticsSnapshot } from './execution-statistics.js'
import { transaction } from '../database/transaction.js'

export interface ExecutionStatisticsWork {
  runId: string
  claimToken: string
  executionStartedAt: string
  executionFinishedAt: string
}

interface ClaimedRow {
  run_id: string
  claim_token: string
  execution_started_at: string
  execution_finished_at: string
}

const TOKEN_COLUMNS = [
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'reasoning_tokens'
] as const

function tokenValues(
  snapshot: ExecutionStatisticsSnapshot
): Array<number | null> {
  return [
    snapshot.tokenUsage.input,
    snapshot.tokenUsage.output,
    snapshot.tokenUsage.total,
    snapshot.tokenUsage.cache_read_input_tokens,
    snapshot.tokenUsage.cache_creation_input_tokens,
    snapshot.tokenUsage.reasoning
  ]
}

/** Durable queue and relational snapshot for terminal execution statistics. */
export class ExecutionStatisticsStore {
  private readonly pool: Pool

  constructor({
    connectionString,
    connectorId,
    claimTimeoutMs,
    initialDelayMs,
    settlementWindowMs
  }: {
    connectionString: string
    connectorId: string
    claimTimeoutMs: number
    initialDelayMs: number
    settlementWindowMs: number
  }) {
    this.pool = new Pool({ connectionString })
    this.connectorId = connectorId
    this.claimTimeoutMs = claimTimeoutMs
    this.initialDelayMs = initialDelayMs
    this.settlementWindowMs = settlementWindowMs
    this.pool.on('error', (error: Error) => {
      console.error(
        'execution_statistics_pool_idle_client_error',
        error.message
      )
    })
  }

  private readonly connectorId: string
  private readonly claimTimeoutMs: number
  private readonly initialDelayMs: number
  private readonly settlementWindowMs: number

  async close(): Promise<void> {
    await this.pool.end()
  }

  /** Admit newly terminal executions and claim one due reconciliation row. */
  async claimNext(): Promise<ExecutionStatisticsWork | null> {
    const token = crypto.randomUUID()
    return await transaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO execution_statistics
           (run_id,status,next_attempt_at)
         SELECT e.run_id,'pending',
                e.finished_at + ($2::bigint * interval '1 millisecond')
         FROM executions e
         JOIN review_runs r ON r.run_id=e.run_id AND r.connector_id=e.connector_id
         WHERE r.connector_id=$1 AND e.status IN ('succeeded','failed')
           AND e.started_at IS NOT NULL AND e.finished_at IS NOT NULL
         ON CONFLICT (run_id) DO NOTHING`,
        [this.connectorId, this.initialDelayMs]
      )
      const selected = await client.query<{ run_id: string }>(
        `SELECT s.run_id
         FROM execution_statistics s
         JOIN review_runs r ON r.run_id=s.run_id
         WHERE r.connector_id=$1
           AND s.next_attempt_at <= clock_timestamp()
           AND (
             s.status='pending'
             OR (s.status='reconciling'
               AND s.claimed_at <= clock_timestamp()-($2::bigint * interval '1 millisecond'))
           )
         ORDER BY s.next_attempt_at,s.run_id
         FOR UPDATE OF s SKIP LOCKED LIMIT 1`,
        [this.connectorId, this.claimTimeoutMs]
      )
      const runId = selected.rows[0]?.run_id
      if (runId === undefined) return null
      const claimed = await client.query<ClaimedRow>(
        `UPDATE execution_statistics s
         SET status='reconciling',claim_token=$2,claimed_at=clock_timestamp(),
             reconciliation_deadline_at=COALESCE(
               s.reconciliation_deadline_at,
               clock_timestamp()+($3::bigint * interval '1 millisecond')
             ),
             updated_at=clock_timestamp()
         FROM executions e
         WHERE s.run_id=$1 AND e.run_id=s.run_id
         RETURNING s.run_id,s.claim_token,
           e.started_at::text AS execution_started_at,
           e.finished_at::text AS execution_finished_at`,
        [runId, token, this.settlementWindowMs]
      )
      const row = claimed.rows[0]
      if (row === undefined)
        throw new Error(
          `Execution statistics work changed while claiming ${runId}.`
        )
      return {
        runId: row.run_id,
        claimToken: row.claim_token,
        executionStartedAt: new Date(row.execution_started_at).toISOString(),
        executionFinishedAt: new Date(row.execution_finished_at).toISOString()
      }
    })
  }

  /** Save one successful read and either schedule the confirming read or settle it. */
  async recordSnapshot(
    work: ExecutionStatisticsWork,
    snapshot: ExecutionStatisticsSnapshot,
    confirmationDelayMs: number
  ): Promise<'pending' | 'settled' | 'partial_window' | 'no_observations'> {
    return await transaction(this.pool, async (client) => {
      const current = await client.query<{
        observation_set_hash: string | null
        deadline_reached: boolean
      }>(
        `SELECT observation_set_hash,
                reconciliation_deadline_at <= clock_timestamp() AS deadline_reached
         FROM execution_statistics
         WHERE run_id=$1 AND status='reconciling' AND claim_token=$2
         FOR UPDATE`,
        [work.runId, work.claimToken]
      )
      const row = current.rows[0]
      if (row === undefined)
        throw new Error(
          `Execution statistics claim was lost for ${work.runId}.`
        )
      // An empty Langfuse result cannot prove zero model calls: the agents may not be
      // exporting. Keep polling for the whole window and report that absence explicitly.
      const hasReviewRoots = snapshot.rootTraceCount > 0
      const stable =
        hasReviewRoots &&
        row.observation_set_hash !== null &&
        row.observation_set_hash === snapshot.observationSetHash
      const terminal = stable || row.deadline_reached
      const result = stable
        ? 'settled'
        : row.deadline_reached
          ? hasReviewRoots
            ? 'partial_window'
            : 'no_observations'
          : 'pending'
      const values = tokenValues(snapshot)
      await client.query(
        `UPDATE execution_statistics
         SET status=$3,
             ingestion_status=$4,
             usage_coverage=$5,
             observation_set_hash=$6,
             root_trace_count=$7,
             excluded_non_review_root_count=$8,
             observed_call_count=$9,
             usage_reported_call_count=$10,
             ${TOKEN_COLUMNS.map((column, index) => `${column}=$${11 + index}`).join(',')},
             next_attempt_at=CASE WHEN $17 THEN next_attempt_at
               ELSE clock_timestamp()+($18::bigint * interval '1 millisecond') END,
             failure_count=0,
             claim_token=NULL,claimed_at=NULL,failure_code=NULL,
             settled_at=CASE WHEN $17 THEN clock_timestamp() ELSE NULL END,
             updated_at=clock_timestamp()
         WHERE run_id=$1 AND status='reconciling' AND claim_token=$2`,
        [
          work.runId,
          work.claimToken,
          terminal ? 'settled' : 'pending',
          terminal ? result : null,
          result === 'no_observations' ? null : snapshot.usageCoverage,
          snapshot.observationSetHash,
          snapshot.rootTraceCount,
          snapshot.excludedNonReviewRootCount,
          snapshot.observedCallCount,
          snapshot.usageReportedCallCount,
          ...values,
          terminal,
          confirmationDelayMs
        ]
      )
      await client.query(
        'DELETE FROM execution_statistics_groups WHERE run_id=$1',
        [work.runId]
      )
      for (const group of snapshot.groups) {
        await client.query(
          `INSERT INTO execution_statistics_groups
             (run_id,agent_name,case_id,delivery_id,pass_kind,pass_index,batch_index,
              chunk_id,provider,model,model_call_count,
              usage_reported_call_count,input_tokens,output_tokens,total_tokens,
              cache_read_input_tokens,cache_creation_input_tokens,reasoning_tokens)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [
            work.runId,
            group.agentName,
            group.caseId,
            group.deliveryId,
            group.passKind,
            group.passIndex,
            group.batchIndex,
            group.chunkId,
            group.provider,
            group.model,
            group.modelCallCount,
            group.usageReportedCallCount,
            group.tokenUsage.input,
            group.tokenUsage.output,
            group.tokenUsage.total,
            group.tokenUsage.cache_read_input_tokens,
            group.tokenUsage.cache_creation_input_tokens,
            group.tokenUsage.reasoning
          ]
        )
      }
      return result
    })
  }

  /** Release a failed read for retry, or conclude it once its transport budget is spent. */
  async recordFailure(
    work: ExecutionStatisticsWork,
    maxFailures: number,
    retryDelayMs: number
  ): Promise<'pending' | 'unavailable'> {
    const result = await this.pool.query<{ status: 'pending' | 'unavailable' }>(
      `UPDATE execution_statistics
       SET failure_count=failure_count+1,
           status=CASE WHEN failure_count+1 >= $3 THEN 'unavailable' ELSE 'pending' END,
           ingestion_status=CASE WHEN failure_count+1 >= $3 THEN 'unavailable' ELSE NULL END,
           usage_coverage=CASE WHEN failure_count+1 >= $3 THEN 'unavailable' ELSE usage_coverage END,
           failure_code=CASE WHEN failure_count+1 >= $3 THEN 'LANGFUSE_UNAVAILABLE' ELSE NULL END,
           next_attempt_at=clock_timestamp()+($4::bigint * interval '1 millisecond'),
           claim_token=NULL,claimed_at=NULL,
           settled_at=CASE WHEN failure_count+1 >= $3 THEN clock_timestamp() ELSE NULL END,
           updated_at=clock_timestamp()
       WHERE run_id=$1 AND status='reconciling' AND claim_token=$2
       RETURNING status`,
      [work.runId, work.claimToken, maxFailures, retryDelayMs]
    )
    const status = result.rows[0]?.status
    if (status === undefined)
      throw new Error(`Execution statistics claim was lost for ${work.runId}.`)
    return status
  }

  /** Defer provider backpressure within the settlement window, or conclude at its deadline. */
  async recordRateLimit(
    work: ExecutionStatisticsWork,
    retryDelayMs: number
  ): Promise<'pending' | 'unavailable'> {
    const result = await this.pool.query<{ status: 'pending' | 'unavailable' }>(
      `WITH timing AS (
         SELECT clock_timestamp() AS now,reconciliation_deadline_at
         FROM execution_statistics
         WHERE run_id=$1 AND status='reconciling' AND claim_token=$2
         FOR UPDATE
       ), decision AS (
         SELECT now,
                now+($3::bigint * interval '1 millisecond') >= reconciliation_deadline_at AS exhausted,
                LEAST(
                  now+($3::bigint * interval '1 millisecond'),
                  reconciliation_deadline_at
                ) AS next_attempt_at
         FROM timing
       )
       UPDATE execution_statistics AS statistics
       SET status=CASE WHEN decision.exhausted THEN 'unavailable' ELSE 'pending' END,
           ingestion_status=CASE WHEN decision.exhausted THEN 'unavailable' ELSE NULL END,
           usage_coverage=CASE
             WHEN decision.exhausted THEN 'unavailable'
             ELSE statistics.usage_coverage
           END,
           failure_code=CASE
             WHEN decision.exhausted THEN 'LANGFUSE_RATE_LIMITED'
             ELSE NULL
           END,
           next_attempt_at=decision.next_attempt_at,
           claim_token=NULL,claimed_at=NULL,
           settled_at=CASE WHEN decision.exhausted THEN decision.now ELSE NULL END,
           updated_at=decision.now
       FROM decision
       WHERE statistics.run_id=$1
         AND statistics.status='reconciling'
         AND statistics.claim_token=$2
       RETURNING statistics.status`,
      [work.runId, work.claimToken, retryDelayMs]
    )
    const status = result.rows[0]?.status
    if (status === undefined)
      throw new Error(`Execution statistics claim was lost for ${work.runId}.`)
    return status
  }
}
