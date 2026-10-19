// Owns Control Plane's durable preparation work: claim leases, recoverable input
// checkpoints, retry exhaustion, and terminal-failure notification outbox state.
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

import type { ControlPlaneWorkflow as WorkflowName } from './contracts.js'

type JsonObject = Record<string, unknown>

export interface PreparationWork {
  run_id: string
  workflow: WorkflowName
  input_version: string
  input: JsonObject
  claim_token: string
  attempt_count: number
}

export interface PreparationFailureNoticeWork {
  run_id: string
  input: JsonObject
  failure_code: string | null
  claim_token: string
}

const MAX_PREPARATION_ATTEMPTS = 8

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

export class PreparationStore {
  constructor(
    private readonly pool: Pool,
    private readonly connectorId: string,
    private readonly claimTimeoutMs: number
  ) {}

  async renewClaim(runId: string, token: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE preparations SET claimed_at=clock_timestamp(), updated_at=clock_timestamp()
       WHERE run_id=$1 AND connector_id=$2 AND status='claimed' AND claim_token=$3`,
      [runId, this.connectorId, token]
    )
    return result.rowCount === 1
  }

  async claimNext(): Promise<PreparationWork | null> {
    return await transaction(this.pool, async (client) => {
      const candidate = await client.query<{
        run_id: string
        workflow: WorkflowName
        input_version: string
        input: JsonObject
        attempt_count: number
      }>(
        `SELECT p.run_id,r.workflow,p.input_version,p.input,p.attempt_count
         FROM preparations p JOIN review_runs r ON r.run_id=p.run_id
         WHERE p.connector_id=$1 AND p.status='pending'
           AND p.available_at <= clock_timestamp()
           AND p.input_version IS NOT NULL AND p.input IS NOT NULL
           AND r.runner_status='preparing'
         ORDER BY p.updated_at,p.run_id FOR UPDATE OF p SKIP LOCKED LIMIT 1`,
        [this.connectorId]
      )
      const work = candidate.rows[0]
      if (work === undefined) return null
      const token = crypto.randomUUID()
      const claimed = await client.query(
        `UPDATE preparations SET status='claimed', claim_token=$2, claimed_at=clock_timestamp(),
           attempt_count=attempt_count+1, failure_code=NULL, failure_message=NULL,
           updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$3 AND status='pending'`,
        [work.run_id, token, this.connectorId]
      )
      if (claimed.rowCount !== 1)
        throw new Error(`Preparation ${work.run_id} could not be claimed.`)
      return {
        ...work,
        claim_token: token,
        attempt_count: work.attempt_count + 1
      }
    })
  }

  async checkpointInput(
    runId: string,
    token: string,
    input: JsonObject
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE preparations SET input=$4::jsonb, updated_at=clock_timestamp()
       WHERE run_id=$1 AND connector_id=$2 AND status='claimed' AND claim_token=$3`,
      [runId, this.connectorId, token, JSON.stringify(input)]
    )
    if (result.rowCount !== 1)
      throw new Error(
        `Preparation claim was lost before checkpointing input for ${runId}.`
      )
  }

  async claimNextFailureNotice(): Promise<PreparationFailureNoticeWork | null> {
    return await transaction(this.pool, async (client) => {
      const candidate = await client.query<{
        run_id: string
        input: JsonObject
        failure_code: string | null
      }>(
        `SELECT n.run_id,p.input,p.failure_code FROM preparation_failure_notices n
         JOIN preparations p ON p.run_id=n.run_id
         WHERE n.connector_id=$1 AND (n.status='pending' OR
           (n.status='claimed' AND n.claimed_at <= clock_timestamp()-($2*interval '1 millisecond')))
         ORDER BY n.updated_at,n.run_id FOR UPDATE OF n SKIP LOCKED LIMIT 1`,
        [this.connectorId, this.claimTimeoutMs]
      )
      const work = candidate.rows[0]
      if (work === undefined) return null
      const token = crypto.randomUUID()
      await client.query(
        `UPDATE preparation_failure_notices SET status='claimed', claim_token=$2,
           claimed_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$3`,
        [work.run_id, token, this.connectorId]
      )
      return { ...work, claim_token: token }
    })
  }

  async completeFailureNotice(
    runId: string,
    token: string,
    delivered: boolean
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE preparation_failure_notices SET status=$4, claim_token=NULL,
         claimed_at=NULL, updated_at=clock_timestamp()
       WHERE run_id=$1 AND connector_id=$2 AND status='claimed' AND claim_token=$3`,
      [runId, this.connectorId, token, delivered ? 'delivered' : 'skipped']
    )
    return result.rowCount === 1
  }

  heartbeatIntervalMs(): number {
    return Math.max(1, Math.min(60_000, Math.floor(this.claimTimeoutMs / 3)))
  }

  async expireStale(): Promise<number> {
    return await transaction(this.pool, async (client) => {
      const expired = await client.query<{
        run_id: string
        status: 'pending' | 'failed'
      }>(
        `UPDATE preparations
         SET status=CASE WHEN attempt_count >= $3 THEN 'failed' ELSE 'pending' END,
             claim_token=NULL, claimed_at=NULL, available_at=clock_timestamp(),
             failure_code=CASE WHEN attempt_count >= $3 THEN 'PREPARATION_RETRY_EXHAUSTED' ELSE NULL END,
             failure_message=CASE WHEN attempt_count >= $3 THEN
               'Preparation claim lease expired after the retry budget was exhausted.' ELSE NULL END,
             updated_at=clock_timestamp()
         WHERE connector_id=$1 AND status='claimed'
           AND claimed_at <= clock_timestamp()-($2*interval '1 millisecond')
         RETURNING run_id,status`,
        [this.connectorId, this.claimTimeoutMs, MAX_PREPARATION_ATTEMPTS]
      )
      const failedRunIds = expired.rows
        .filter((row) => row.status === 'failed')
        .map((row) => row.run_id)
      if (failedRunIds.length === 0) return expired.rowCount ?? 0
      const failedRuns = await client.query<{ run_id: string }>(
        `UPDATE review_runs SET runner_status='failed', runner_failure_code='PREPARATION_RETRY_EXHAUSTED',
           runner_failure_message='Preparation claim lease expired after the retry budget was exhausted.',
           updated_at=clock_timestamp()
         WHERE run_id=ANY($1::text[]) AND connector_id=$2 AND runner_status='preparing' RETURNING run_id`,
        [failedRunIds, this.connectorId]
      )
      if (failedRuns.rowCount !== failedRunIds.length)
        throw new Error('Preparation expiry lost a terminal run transition.')
      await client.query(
        `UPDATE publications SET status='skipped', claim_token=NULL, failure_code=NULL,
           failure_message=NULL, updated_at=clock_timestamp()
         WHERE run_id=ANY($1::text[]) AND connector_id=$2 AND status='pending'`,
        [failedRunIds, this.connectorId]
      )
      await client.query(
        `INSERT INTO preparation_failure_notices (run_id,connector_id,status)
         SELECT unnest($1::text[]),$2,'pending' ON CONFLICT (run_id) DO NOTHING`,
        [failedRunIds, this.connectorId]
      )
      return expired.rowCount ?? 0
    })
  }

  async fail(
    runId: string,
    token: string,
    error: { code?: string | null; message: string },
    options: { retry: boolean; retryAfterMs?: number }
  ): Promise<{ retry_scheduled: boolean }> {
    return await transaction(this.pool, async (client) => {
      if (options.retry) {
        const retry = await client.query(
          `UPDATE preparations SET status='pending', claim_token=NULL, claimed_at=NULL,
             available_at=clock_timestamp() + ($4::bigint * interval '1 millisecond'),
             failure_code=$5, failure_message=$6, updated_at=clock_timestamp()
           WHERE run_id=$1 AND connector_id=$2 AND status='claimed' AND claim_token=$3
             AND attempt_count < $7`,
          [
            runId,
            this.connectorId,
            token,
            Math.max(0, options.retryAfterMs ?? 0),
            error.code ?? null,
            error.message,
            MAX_PREPARATION_ATTEMPTS
          ]
        )
        if (retry.rowCount === 1) return { retry_scheduled: true }
      }
      const result = await client.query(
        `UPDATE review_runs SET runner_status='failed', runner_failure_code=$4,
           runner_failure_message=$5, updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND runner_status='preparing' AND EXISTS (
           SELECT 1 FROM preparations WHERE preparations.run_id=review_runs.run_id
             AND preparations.connector_id=$2 AND preparations.status='claimed' AND preparations.claim_token=$3)`,
        [runId, this.connectorId, token, error.code ?? null, error.message]
      )
      if (result.rowCount !== 1)
        throw new Error(
          `Preparation claim was lost before failing review run ${runId}.`
        )
      await client.query(
        `UPDATE preparations SET status='failed', claim_token=NULL, claimed_at=NULL,
           failure_code=$4, failure_message=$5, updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='claimed' AND claim_token=$3`,
        [runId, this.connectorId, token, error.code ?? null, error.message]
      )
      await client.query(
        `UPDATE publications SET status='skipped', claim_token=NULL, failure_code=NULL,
           failure_message=NULL, updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='pending'`,
        [runId, this.connectorId]
      )
      await client.query(
        `INSERT INTO preparation_failure_notices (run_id,connector_id,status)
         VALUES ($1,$2,'pending') ON CONFLICT (run_id) DO NOTHING`,
        [runId, this.connectorId]
      )
      return { retry_scheduled: false }
    })
  }
}
