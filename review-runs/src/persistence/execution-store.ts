// Owns the execution axis: Execution submission fencing, execution-status transitions, the
// observation heartbeat, and the terminal artifact/result writes.
//
// This store only performs single-axis transactions on `executions`. Transitions that must
// also move another axis in the same transaction (submission -> queued, terminal failure ->
// publication skipped) live in concrete cross-axis transition stores behind `ReviewRunStore`.
// A resolved recovery changes only execution, but its write still asserts that publication is
// pending, so it belongs to `SubmissionTransitionStore`. Reading the full run record is likewise
// not here: the record projection spans all three axes.
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

import type { ExecutionArtifactStorage } from '../contracts.js'
import { appendEvent } from './review-run-events.js'
import { queueRunNotice } from './run-notices.js'
import { transaction } from '../database/transaction.js'
import { normalizeArtifactStorage } from '../shapes.js'

export class ExecutionStore {
  constructor(
    private readonly pool: Pool,
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

  /** Hand a disconnected execution back to automatic replay, on an operator's decision.
   *
   * Disconnection is reached when the replay budget is spent, and nothing else can move the row:
   * `claimSubmissionRecovery` only takes `uncertain`, and no automatic path selects a
   * `disconnected` execution. Without this the run would be permanently stuck with no owner and
   * no writer, which is why the only other outcome is abandoning it.
   *
   * `attempt_count` is reset because it is the budget the disconnect consumed: a row resumed with
   * the count intact would be disconnected again by the next coordination pass, and the
   * operator's decision would never get a replay to act on. The reset grants attempts, not facts
   * — the run still does not know whether the Execution accepted anything.
   *
   * Returns false when the row is not (or no longer) disconnected. */
  async resumeDisconnectedSubmissionRecovery(runId: string): Promise<boolean> {
    return await transaction(
      this.pool,
      async (client) =>
        await this.resumeDisconnectedSubmissionRecoveryOn(client, runId)
    )
  }

  /** The same decision, on a transaction the caller already opened.
   *
   * An operator resume re-claims the execution and reads the record it returns in one
   * transaction. Opening a second transaction for the claim deadlocks when the caller holds the
   * pool's only connection, so the decision takes the caller's transaction instead. */
  async resumeDisconnectedSubmissionRecoveryOn(
    client: PoolClient,
    runId: string
  ): Promise<boolean> {
    {
      const result = await client.query<{ run_id: string }>(
        `UPDATE executions
         SET status='uncertain', claim_token=NULL, claimed_at=NULL,
             attempt_count=0, updated_at=clock_timestamp()
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
      return true
    }
  }

  /** Stop automatic recovery for an uncertain submission whose replay budget is exhausted.
   *
   * `recordUnknownRecoveryOutcome` keeps handing the row back to another owner, so an Execution provider that
   * answers every replay with another timeout would leave the run `uncertain` forever. That is
   * not evidence that the Execution rejected it, though, so the only automatic conclusion is
   * `disconnected`: stop issuing replays and make the uncertainty visible to an operator.
   *
   * The take is an UPDATE gated on the budget *and* the claim, so a caller that read an outdated
   * count cannot conclude a run that a concurrent owner has just taken, and two owners cannot
   * both conclude the same row. Returns whether this caller is the one that disconnected it, or
   * false when the row is not (or no longer) over budget. It deliberately returns no claim token:
   * `disconnected` holds no claim, so a token here would name an owner that never existed. */
  async disconnectExhaustedSubmissionRecovery(
    runId: string,
    maxAttempts: number
  ): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      const result = await client.query<{ run_id: string }>(
        `
        UPDATE executions
        SET status='disconnected', claim_token=NULL, claimed_at=NULL,
            updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2
          AND status='uncertain'
          AND attempt_count >= $3
          AND (claim_token IS NULL
            OR claimed_at <= clock_timestamp()-($4*interval '1 millisecond'))
        RETURNING run_id
      `,
        [runId, this.connectorId, maxAttempts, this.claimTimeoutMs]
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

  /** Record that a replay was handed to the Execution and its outcome is still unknown.
   *
   * The axis stays `uncertain` — that is what the state means, and concluding anything from an
   * unknown answer is exactly the mistake the state exists to prevent. What this adds is the
   * budget: the count is what eventually disconnects a run whose replays never resolve. The
   * claim token is kept (not cleared) so the next replay waits for this owner's lease to
   * expire instead of retrying on the very next tick. */
  async recordUnknownRecoveryOutcome(
    runId: string,
    token: string
  ): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      const result = await client.query(
        `
        UPDATE executions
        SET attempt_count=attempt_count+1,
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
