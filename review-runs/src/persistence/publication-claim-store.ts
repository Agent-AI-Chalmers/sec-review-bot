// Claims publication ownership only when the execution result is publishable and no publication
// step is parked. Step-level writes remain in `PublicationStore`.
import crypto from 'node:crypto'
import type { Pool } from 'pg'

import { transaction } from '../database/transaction.js'
import type { PublicationStatus, PublicationWork } from '../shapes.js'
import { appendEvent } from './review-run-events.js'
import {
  RUN_SELECT,
  rowToRecord,
  type ReviewRunRow
} from './run-record-projection.js'

const CLAIM_WAIT_INTERVAL_MS = 250

export class PublicationClaimStore {
  constructor(
    private readonly pool: Pool,
    private readonly connectorId: string,
    private readonly claimTimeoutMs: number
  ) {}

  /** Claim one known run once its execution has a non-null result and its lease is available. */
  async claim(runId: string): Promise<string | null> {
    const token = crypto.randomUUID()
    return await transaction(this.pool, async (client) => {
      const result = await client.query<{
        claim_token: string
        from_status: PublicationStatus
      }>(
        `WITH previous AS (
           SELECT run_id, status FROM publications
           WHERE run_id=$1 AND connector_id=$3
           FOR UPDATE
         )
         UPDATE publications p
         SET status='publishing', claim_token=$2, claimed_at=clock_timestamp(),
             started_at=COALESCE(p.started_at, clock_timestamp()),
             failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
         FROM previous, executions e
         WHERE p.run_id=previous.run_id AND previous.run_id=$1 AND p.connector_id=$3
           AND e.run_id=p.run_id AND e.connector_id=p.connector_id
           AND e.status='succeeded' AND jsonb_typeof(e.workflow_result) <> 'null'
           AND NOT EXISTS (SELECT 1 FROM publication_steps s
             WHERE s.run_id=p.run_id AND s.connector_id=p.connector_id
               AND s.status='disconnected')
           AND (
             previous.status='pending'
             OR (previous.status IN ('publishing','uncertain')
               AND p.claimed_at <= clock_timestamp()-($4*interval '1 millisecond'))
           )
         RETURNING p.claim_token, previous.status AS from_status`,
        [runId, token, this.connectorId, this.claimTimeoutMs]
      )
      const claimed = result.rows[0]
      if (claimed === undefined) return null
      await this.appendClaimEvent(client, runId, claimed.from_status)
      return claimed.claim_token
    })
  }

  /** Claim the next publishable run, optionally polling until the bounded wait elapses. */
  async claimNext(waitMs = 0): Promise<PublicationWork | null> {
    const boundedWaitMs =
      Number.isFinite(waitMs) && waitMs > 0 ? Math.min(waitMs, 30_000) : 0
    const deadline = Date.now() + boundedWaitMs
    for (;;) {
      const work = await this.claimNextOnce()
      if (work !== null || Date.now() >= deadline) return work
      await new Promise((resolve) =>
        setTimeout(resolve, CLAIM_WAIT_INTERVAL_MS)
      )
    }
  }

  private async claimNextOnce(): Promise<PublicationWork | null> {
    return await transaction(this.pool, async (client) => {
      const candidate = await client.query<{
        run_id: string
        status: PublicationStatus
      }>(
        `SELECT p.run_id, p.status
         FROM publications p
         JOIN executions e ON e.run_id=p.run_id AND e.connector_id=p.connector_id
         WHERE p.connector_id=$1
           AND e.status='succeeded' AND jsonb_typeof(e.workflow_result) <> 'null'
           AND NOT EXISTS (SELECT 1 FROM publication_steps s
             WHERE s.run_id=p.run_id AND s.connector_id=p.connector_id
               AND s.status='disconnected')
           AND (p.status='pending' OR
             (p.status IN ('publishing','uncertain')
               AND p.claimed_at <= clock_timestamp()-($2*interval '1 millisecond')))
         ORDER BY p.updated_at
         FOR UPDATE OF p SKIP LOCKED
         LIMIT 1`,
        [this.connectorId, this.claimTimeoutMs]
      )
      const candidateRow = candidate.rows[0]
      if (candidateRow === undefined) return null
      const runId = candidateRow.run_id
      const token = crypto.randomUUID()
      // Restate every claimability condition in the UPDATE. The SELECT lock serializes current
      // callers; the repeated predicate also prevents a future split from weakening the fence.
      const claimed = await client.query(
        `UPDATE publications p SET status='publishing', claim_token=$3,
           claimed_at=clock_timestamp(),
           started_at=COALESCE(p.started_at, clock_timestamp()),
           failure_code=NULL, failure_message=NULL,
           updated_at=clock_timestamp()
         FROM executions e
         WHERE p.run_id=$1 AND p.connector_id=$2 AND p.status=$4
           AND e.run_id=p.run_id AND e.connector_id=p.connector_id
           AND e.status='succeeded' AND jsonb_typeof(e.workflow_result) <> 'null'
           AND NOT EXISTS (SELECT 1 FROM publication_steps s
             WHERE s.run_id=p.run_id AND s.connector_id=p.connector_id
               AND s.status='disconnected')
           AND (
             $4='pending'
             OR ($4 IN ('publishing','uncertain')
               AND p.claimed_at <= clock_timestamp()-($5*interval '1 millisecond'))
           )`,
        [
          runId,
          this.connectorId,
          token,
          candidateRow.status,
          this.claimTimeoutMs
        ]
      )
      if (claimed.rowCount !== 1)
        throw new Error(
          `Publication work changed while being claimed: ${runId}`
        )
      await this.appendClaimEvent(client, runId, candidateRow.status)
      const result = await client.query<ReviewRunRow>(
        `${RUN_SELECT}
         WHERE r.run_id=$1 AND r.connector_id=$2`,
        [runId, this.connectorId]
      )
      const row = result.rows[0]
      if (row === undefined || row.execution.workflow_result === null)
        throw new Error(`Claimed publication work is incomplete: ${runId}`)
      return {
        ...rowToRecord(row),
        workflow_result: row.execution.workflow_result,
        claim_token: token
      }
    })
  }

  private async appendClaimEvent(
    client: Parameters<typeof appendEvent>[0],
    runId: string,
    fromStatus: PublicationStatus
  ): Promise<void> {
    await appendEvent(client, {
      runId,
      connectorId: this.connectorId,
      axis: 'publication',
      fromStatus,
      toStatus: 'publishing',
      reasonCode:
        fromStatus === 'publishing' || fromStatus === 'uncertain'
          ? 'PUBLICATION_LEASE_EXPIRED'
          : null
    })
  }
}
