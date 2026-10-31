// Owns the cross-axis database transitions around Execution submission. Recovery leases and
// attempt budgets remain in `ExecutionStore` because those writes touch only the execution axis.
import type { Pool, PoolClient } from 'pg'
import type { Database } from '../database/database.js'

import type { ReviewRunWorkflow } from '../contracts.js'
import { transaction } from '../database/transaction.js'
import { abandonInFlightPublication } from './publication-abandon.js'
import { appendEvent } from './review-run-events.js'
import { requirePreparationClaim } from './input-bundle-candidate-store.js'
import { queueRunNotice } from './run-notices.js'

type JsonObject = Record<string, unknown>
type SubmissionError = { code?: string | null; message: string }

export class SubmissionTransitionStore {
  /** The pool, guarded by the database's readiness check. */
  protected get pool(): Pool {
    return this.database.pool()
  }

  constructor(
    private readonly database: Database,
    private readonly connectorId: string,
    private readonly claimTimeoutMs: number
  ) {}

  private async findWorkflow(
    client: PoolClient,
    runId: string
  ): Promise<ReviewRunWorkflow | null> {
    const result = await client.query<{ workflow: ReviewRunWorkflow }>(
      `SELECT workflow FROM review_runs
       WHERE run_id=$1 AND connector_id=$2`,
      [runId, this.connectorId]
    )
    return result.rows[0]?.workflow ?? null
  }

  async savePreparedSubmission(
    runId: string,
    token: string,
    context: JsonObject,
    input: JsonObject
  ): Promise<void> {
    await transaction(this.pool, async (client) => {
      await requirePreparationClaim(
        client,
        runId,
        this.connectorId,
        token,
        this.claimTimeoutMs
      )
      // Match the complete persisted intent, not just its digest. A response-loss replay
      // may repeat a selection, but cannot rewrite the input under an already chosen object.
      const candidate = await client.query(
        `UPDATE input_bundle_candidates c SET status='selected',
           updated_at=CASE WHEN status='selected' THEN updated_at ELSE clock_timestamp() END
         WHERE run_id=$1 AND connector_id=$2 AND reference=$3::jsonb
           AND input=$4::jsonb AND publish_context=$5::jsonb
           AND status IN ('present','selected')
           AND NOT EXISTS (SELECT 1 FROM input_bundle_candidates other
             WHERE other.run_id=c.run_id AND other.status='selected' AND other.digest<>c.digest)
         RETURNING digest`,
        [
          runId,
          this.connectorId,
          JSON.stringify(input.input_bundle ?? null),
          JSON.stringify(input),
          JSON.stringify(context)
        ]
      )
      if (candidate.rowCount !== 1)
        throw new Error('Prepared input has no matching published candidate.')
      const execution = await client.query(
        `UPDATE executions SET input=$3::jsonb, updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='pending'
           AND (input IS NULL OR input=$3::jsonb)`,
        [runId, this.connectorId, JSON.stringify(input)]
      )
      const publication = await client.query(
        `UPDATE publications SET input=$3::jsonb, updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='pending'`,
        [runId, this.connectorId, JSON.stringify(context)]
      )
      if (execution.rowCount !== 1 || publication.rowCount !== 1)
        throw new Error('Run cannot save prepared submission outside pending.')
      await client.query(
        `UPDATE input_bundle_candidates SET status='abandoned', updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status IN ('reserved','present')`,
        [runId, this.connectorId]
      )
    })
  }

  async markQueued(
    runId: string,
    token: string,
    context: JsonObject
  ): Promise<void> {
    await transaction(this.pool, async (client) => {
      const workflow = await this.findWorkflow(client, runId)
      if (workflow === null)
        throw Object.assign(new Error(`Review run does not exist: ${runId}`), {
          statusCode: 404
        })
      // Execution may have accepted the saved request just as the lease elapsed. Finish
      // recording that acknowledgement only if no expiry/takeover has replaced this owner.
      await client.query(
        `SELECT run_id FROM preparations WHERE run_id=$1 FOR UPDATE`,
        [runId]
      )
      const publication = await client.query(
        `UPDATE publications
         SET input=$2::jsonb, updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$3
           AND status='pending'
           AND EXISTS (
             SELECT 1 FROM review_runs r
             WHERE r.run_id=publications.run_id AND r.connector_id=$3 AND r.workflow=$4
           )`,
        [runId, JSON.stringify(context), this.connectorId, workflow]
      )
      const execution = await client.query(
        `UPDATE executions
         SET status='queued', started_at=COALESCE(started_at, clock_timestamp()),
             failure_code=NULL, failure_message=NULL,
             observed_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$3
           AND status='pending' AND EXISTS (
             SELECT 1 FROM preparations
             WHERE preparations.run_id=executions.run_id
               AND preparations.connector_id=$3 AND preparations.status='preparing'
               AND preparations.claim_token=$2
           )`,
        [runId, token, this.connectorId]
      )
      if (publication.rowCount !== 1 || execution.rowCount !== 1)
        throw new Error(
          `Review run ${runId} cannot transition from pending to queued.`
        )
      const preparation = await client.query(
        `UPDATE preparations
         SET status='submitted', claim_token=NULL, claimed_at=NULL,
             finished_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='preparing'
           AND claim_token=$3`,
        [runId, this.connectorId, token]
      )
      if (preparation.rowCount !== 1)
        throw new Error(
          `Preparation ${runId} lost its claim before the queued transition completed.`
        )
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'execution',
        fromStatus: 'pending',
        toStatus: 'queued'
      })
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'preparation',
        fromStatus: 'preparing',
        toStatus: 'submitted'
      })
    })
  }

  async completeSubmissionRecovery(
    runId: string,
    token: string
  ): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE executions
         SET status='queued', claim_token=NULL, claimed_at=NULL,
             started_at=COALESCE(started_at, clock_timestamp()),
             failure_code=NULL, failure_message=NULL,
             observed_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2
           AND status='uncertain' AND claim_token=$3
           AND EXISTS (
             SELECT 1 FROM publications p
             WHERE p.run_id=executions.run_id AND p.connector_id=executions.connector_id
               AND p.status='pending'
           )`,
        [runId, this.connectorId, token]
      )
      if (result.rowCount !== 1) return false
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'execution',
        fromStatus: 'uncertain',
        toStatus: 'queued'
      })
      return true
    })
  }

  async failSubmissionRecovery(
    runId: string,
    token: string,
    error: SubmissionError
  ): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE executions
         SET status='failed', claim_token=NULL, claimed_at=NULL,
             failure_code=$4, failure_message=$5,
             finished_at=clock_timestamp(),
             observed_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2
           AND status='uncertain' AND claim_token=$3`,
        [runId, this.connectorId, token, error.code ?? null, error.message]
      )
      if (result.rowCount !== 1) return false
      const publicationFrom = await abandonInFlightPublication(
        client,
        this.connectorId,
        runId
      )
      const executionEventId = await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'execution',
        fromStatus: 'uncertain',
        toStatus: 'failed',
        reasonCode: error.code ?? null
      })
      await queueRunNotice(client, {
        runId,
        connectorId: this.connectorId,
        sourceEventId: executionEventId,
        kind: 'failure',
        axis: 'execution',
        reasonCode: error.code ?? null
      })
      if (publicationFrom !== null) {
        await appendEvent(client, {
          runId,
          connectorId: this.connectorId,
          axis: 'publication',
          fromStatus: publicationFrom,
          toStatus: 'skipped',
          reasonCode: 'PUBLICATION_ABANDONED'
        })
      }
      return true
    })
  }
}
