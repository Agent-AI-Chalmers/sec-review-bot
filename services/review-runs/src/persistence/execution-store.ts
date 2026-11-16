// Owns the execution axis: Execution submission fencing, execution-status transitions, the
// observation heartbeat, and the terminal artifact/result writes.
//
// This store only performs single-axis transactions on `executions`. Transitions that must
// also move another axis in the same transaction (submission -> queued, terminal failure ->
// publication skipped) stay at explicit cross-axis boundaries. Submission changes live in
// `SubmissionTransitionStore`; terminal execution failure remains on the composition root because
// it atomically concludes execution and publication. A resolved recovery changes only execution,
// but its write still asserts that publication is pending, so it also belongs to
// `SubmissionTransitionStore`. Reading the full run record is likewise not here: the record
// projection spans all three axes.
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import type { Database } from '../database/database.js'

import type { ExecutionArtifactStorage } from '../contracts.js'
import { appendEvent } from './review-run-events.js'
import { queueRunNotice, supersedeRunAttentionNotices } from './run-notices.js'
import { transaction } from '../database/transaction.js'
import { normalizeArtifactStorage } from '../shapes.js'

export class ExecutionStore {
  /** The pool, guarded by the database's readiness check. */
  protected get pool(): Pool {
    return this.database.pool()
  }

  constructor(
    private readonly database: Database,
    private readonly connectorId: string,
    private readonly claimTimeoutMs: number
  ) {}

  /** Record that the Execution was observed just now, without changing state.
   *
   * Polling learns a run's state by asking the Execution. When the answer matches the state
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
    storage: ExecutionArtifactStorage | undefined
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

  async recordExecutionSuccess(
    runId: string,
    workflowResult: unknown,
    storage: ExecutionArtifactStorage | undefined
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

  /** Take the recovery claim for an uncertain submission.
   *
   * The claim is what paces retries: a replay whose outcome is unknown leaves it in place, so the
   * run becomes claimable again only when this lease expires rather than on the next coordination
   * tick. Clearing the claim on a failed replay would replay the same submission every tick.
   */
  async claimSubmissionRecovery(
    runId: string,
    maxUnresolvedRecoveries: number
  ): Promise<string | null> {
    const token = crypto.randomUUID()
    return await transaction(this.pool, async (client) => {
      const result = await client.query<{ claim_token: string }>(
        `
        UPDATE executions
        SET claim_token=$2, claimed_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$3
          AND status='uncertain' AND unresolved_recovery_count < $5
          AND (claim_token IS NULL
            OR claimed_at <= clock_timestamp()-($4*interval '1 millisecond'))
        RETURNING claim_token
      `,
        [
          runId,
          token,
          this.connectorId,
          this.claimTimeoutMs,
          maxUnresolvedRecoveries
        ]
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

  /** Resume automatic recovery with a fresh unresolved-result budget.
   * The submission remains uncertain; only its automatic recovery allowance is reset.
   */
  async resumeDisconnectedSubmissionRecovery(runId: string): Promise<boolean> {
    return await transaction(
      this.pool,
      async (client) =>
        await this.resumeDisconnectedSubmissionRecoveryOn(client, runId)
    )
  }

  /** Apply resume in the operator decision's transaction. */
  async resumeDisconnectedSubmissionRecoveryOn(
    client: PoolClient,
    runId: string
  ): Promise<boolean> {
    {
      const result = await client.query<{ run_id: string }>(
        `UPDATE executions
         SET status='uncertain', claim_token=NULL, claimed_at=NULL,
             unresolved_recovery_count=0, updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='disconnected'
         RETURNING run_id`,
        [runId, this.connectorId]
      )
      if (result.rows[0] === undefined) return false
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'execution',
        fromStatus: 'disconnected',
        toStatus: 'uncertain',
        reasonCode: 'SUBMISSION_RECOVERY_RESUMED_BY_OPERATOR'
      })
      await supersedeRunAttentionNotices(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'execution'
      })
      return true
    }
  }

  /** Stop over-budget recovery only when no live recovery lease prevents the decision.
   * Atomically check count, state, and lease; enqueue attention with the transition.
   */
  async disconnectExhaustedSubmissionRecovery(
    runId: string,
    maxUnresolvedRecoveries: number
  ): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      const result = await client.query<{ run_id: string }>(
        `
        UPDATE executions
        SET status='disconnected', claim_token=NULL, claimed_at=NULL,
            updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2
          AND status='uncertain'
          AND unresolved_recovery_count >= $3
          AND (claim_token IS NULL
            OR claimed_at <= clock_timestamp()-($4*interval '1 millisecond'))
        RETURNING run_id
      `,
        [runId, this.connectorId, maxUnresolvedRecoveries, this.claimTimeoutMs]
      )
      if (result.rows[0] === undefined) return false
      const eventId = await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'execution',
        fromStatus: 'uncertain',
        toStatus: 'disconnected',
        reasonCode: 'SUBMISSION_RECOVERY_EXHAUSTED'
      })
      await queueRunNotice(client, {
        runId,
        connectorId: this.connectorId,
        sourceEventId: eventId,
        kind: 'attention',
        axis: 'execution',
        reasonCode: 'SUBMISSION_RECOVERY_EXHAUSTED'
      })
      return true
    })
  }

  /** Count one replay whose acceptance remains unknown, retaining the lease to pace retries. */
  async recordUnknownRecoveryOutcome(
    runId: string,
    token: string
  ): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      const result = await client.query(
        `
        UPDATE executions
        SET unresolved_recovery_count=unresolved_recovery_count+1,
            updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2
          AND status='uncertain' AND claim_token=$3
      `,
        [runId, this.connectorId, token]
      )
      return result.rowCount === 1
    })
  }
}
