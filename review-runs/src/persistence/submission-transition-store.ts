// Owns the cross-axis database transitions around Execution submission. Recovery leases and
// attempt budgets remain in `ExecutionStore` because those writes touch only the execution axis.
import type { Pool, PoolClient } from 'pg'

import type { ReviewRunWorkflow } from '../contracts.js'
import { transaction } from '../database/transaction.js'
import { abandonInFlightPublication } from './publication-abandon.js'
import { appendEvent } from './review-run-events.js'
import { queueRunNotice } from './run-notices.js'

type JsonObject = Record<string, unknown>
type SubmissionError = { code?: string | null; message: string }

export class SubmissionTransitionStore {
  constructor(
    private readonly pool: Pool,
    private readonly connectorId: string
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
    // The transaction is required even though both writes share one data-modifying CTE: each CTE
    // arm runs independently, so a failed trailing check must roll the publication write back.
    await transaction(this.pool, async (client) => {
      const workflow = await this.findWorkflow(client, runId)
      if (workflow === null)
        throw new Error(`Review run does not exist: ${runId}`)
      const result = await client.query(
        `
        WITH updated_publication AS (
          UPDATE publications
          SET input=$3::jsonb, updated_at=clock_timestamp()
          WHERE run_id=$1 AND connector_id=$5
            AND EXISTS (
              SELECT 1 FROM review_runs r
              WHERE r.run_id=publications.run_id AND r.connector_id=$5 AND r.workflow=$6
            )
          RETURNING run_id
        ),
        updated_execution AS (
          UPDATE executions
          SET input=$4::jsonb, updated_at=clock_timestamp()
          WHERE run_id=$1 AND connector_id=$5
            AND status='pending' AND EXISTS (
              SELECT 1 FROM preparations
              WHERE preparations.run_id=executions.run_id
                AND preparations.connector_id=$5 AND preparations.status='preparing'
                AND preparations.claim_token=$2
            )
          RETURNING run_id
        )
        SELECT run_id FROM updated_execution
        WHERE EXISTS (SELECT 1 FROM updated_publication)
      `,
        [
          runId,
          token,
          JSON.stringify(context),
          JSON.stringify(input),
          this.connectorId,
          workflow
        ]
      )
      if (result.rowCount !== 1)
        throw new Error(
          `Review run ${runId} cannot save prepared submission outside pending.`
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
