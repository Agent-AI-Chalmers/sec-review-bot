// Owns the execution axis: Runner submission fencing, execution-status transitions, the
// observation heartbeat, and the terminal artifact/result writes.
//
// This store only performs single-axis transactions on `executions`. Transitions that must
// also move another axis in the same transaction (submission -> queued, terminal failure ->
// publication skipped) stay in `ReviewRunStore`, which owns cross-axis orchestration. A
// resolved recovery moves no other axis: publication stayed `pending` throughout `uncertain`,
// because a submission the Runner may have accepted could still produce a publishable result.
// Reading the full run record is likewise not here: the record projection spans all three axes
// and lives with `ReviewRunStore`.
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

import type { RunnerArtifactStorage } from './contracts.js'
import { appendEvent } from './review-run-events.js'
import { normalizeArtifactStorage } from './shapes.js'

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

export class ExecutionStore {
  constructor(
    private readonly pool: Pool,
    private readonly connectorId: string,
    private readonly claimTimeoutMs: number
  ) {}

  /** Record that the Runner was observed just now, without changing state.
   *
   * Polling learns a run's state by asking the Runner. When the answer matches the state
   * already stored, nothing else would write, so `observed_at` would freeze and the console
   * could not tell a fresh observation from a stale one. This writes `observed_at` only:
   * recovery lease expiry reads `claimed_at`, so an observation heartbeat can never extend a
   * recovery claim. */
  async touchObservation(runId: string): Promise<void> {
    await this.pool.query(
      `UPDATE executions
       SET observed_at=clock_timestamp()
       WHERE run_id=$1 AND connector_id=$2 AND status IN ('queued','running')`,
      [runId, this.connectorId]
    )
  }

  async markRunning(runId: string): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      const result = await client.query(
        `
        UPDATE executions
        SET status='running', observed_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2 AND status='queued'
      `,
        [runId, this.connectorId]
      )
      if (result.rowCount !== 1) return false
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'execution',
        fromStatus: 'queued',
        toStatus: 'running'
      })
      return true
    })
  }

  async recordArtifactStorage(
    runId: string,
    storage: RunnerArtifactStorage | undefined
  ): Promise<void> {
    if (storage === undefined) return
    await this.pool.query(
      `
      UPDATE executions
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
    return await transaction(this.pool, async (client) => {
      // RETURNING the previous status through a CTE gives the event a truthful from_status: the
      // run may have been queued or running, and the log must say which.
      const result = await client.query<{ from_status: string }>(
        `
        WITH previous AS (
          SELECT run_id, status FROM executions
          WHERE run_id=$1 AND connector_id=$2 AND status IN ('queued','running')
          FOR UPDATE
        )
        UPDATE executions e
        SET status='succeeded', workflow_result=$3::jsonb,
            artifact_storage=$4::jsonb, failure_code=NULL,
            failure_message=NULL, finished_at=clock_timestamp(),
            observed_at=clock_timestamp(), updated_at=clock_timestamp()
        FROM previous
        WHERE e.run_id=previous.run_id
        RETURNING previous.status AS from_status
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
      if (result.rowCount !== 1) return false
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'execution',
        fromStatus: result.rows[0]?.from_status ?? null,
        toStatus: 'succeeded'
      })
      return true
    })
  }

  async claimSubmissionRecovery(runId: string): Promise<string | null> {
    const token = crypto.randomUUID()
    return await transaction(this.pool, async (client) => {
      const result = await client.query<{ claim_token: string }>(
        `
        UPDATE executions
        SET claim_token=$2, claimed_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$3
          AND status='uncertain'
          AND (claim_token IS NULL
            OR claimed_at <= clock_timestamp()-($4*interval '1 millisecond'))
        RETURNING claim_token
      `,
        [runId, token, this.connectorId, this.claimTimeoutMs]
      )
      if (result.rows[0] === undefined) return null
      // The state stays `uncertain`; taking the claim is not a transition, so record it as a
      // self-event to keep the operator timeline showing when a replay started.
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'execution',
        fromStatus: 'uncertain',
        toStatus: 'uncertain',
        reasonCode: 'SUBMISSION_RECOVERY_CLAIMED'
      })
      return result.rows[0].claim_token
    })
  }
}
