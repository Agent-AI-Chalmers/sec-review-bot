// Owns admission of a durable run aggregate: the trunk, all three lifecycle axes, the initial
// preparation claim, initial events, and ingress-key idempotency.
import crypto from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

import { transaction } from '../database/transaction.js'
import type {
  CreateReviewRunArgs,
  ReviewRunAdmission,
  ReviewRunRecord
} from '../shapes.js'
import { appendEvent } from './review-run-events.js'
import {
  RUN_SELECT,
  rowToRecord,
  type ReviewRunRow
} from './run-record-projection.js'

type IdempotentAdmissionArgs = CreateReviewRunArgs &
  Required<Pick<CreateReviewRunArgs, 'ingress_kind' | 'ingress_key'>>

const INGRESS_IDENTITY_CONSTRAINT =
  'review_runs_connector_id_ingress_kind_ingress_key_key'

export class ReviewRunAdmissionStore {
  constructor(
    private readonly pool: Pool,
    private readonly connectorId: string,
    private readonly sourcePlatform: ReviewRunRecord['source_platform']
  ) {}

  async create(run: CreateReviewRunArgs): Promise<ReviewRunAdmission> {
    return await transaction(
      this.pool,
      async (client) => await this.insertWith(client, run)
    )
  }

  async admit(run: IdempotentAdmissionArgs): Promise<ReviewRunAdmission> {
    try {
      return await transaction(this.pool, async (client) => {
        const existing = await client.query<ReviewRunRow>(
          `${RUN_SELECT}
           WHERE r.connector_id=$1 AND r.ingress_kind=$2 AND r.ingress_key=$3
           FOR UPDATE OF r`,
          [this.connectorId, run.ingress_kind, run.ingress_key]
        )
        const row = existing.rows[0]
        if (row === undefined) return await this.insertWith(client, run)
        return {
          record: rowToRecord(row),
          created: false,
          preparation_token: null
        }
      })
    } catch (error: unknown) {
      if (!this.isIngressIdentityConflict(error)) throw error
      // The concurrent winner becomes visible only after the failed transaction rolls back.
      const existing = await this.pool.query<ReviewRunRow>(
        `${RUN_SELECT}
         WHERE r.connector_id=$1 AND r.ingress_kind=$2 AND r.ingress_key=$3`,
        [this.connectorId, run.ingress_kind, run.ingress_key]
      )
      const row = existing.rows[0]
      if (row === undefined) {
        throw new Error(
          `ingress replay for ${run.ingress_kind}:${run.ingress_key} lost a concurrent ` +
            `admission that rolled back; the request can be retried`,
          { cause: error }
        )
      }
      return {
        record: rowToRecord(row),
        created: false,
        preparation_token: null
      }
    }
  }

  private async insertWith(
    client: PoolClient,
    run: CreateReviewRunArgs
  ): Promise<ReviewRunAdmission> {
    const preparationToken = crypto.randomUUID()
    await client.query(
      `INSERT INTO review_runs
       (run_id,connector_id,workflow,source_platform,ingress_kind,ingress_key)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        run.run_id,
        this.connectorId,
        run.workflow,
        this.sourcePlatform,
        run.ingress_kind ?? null,
        run.ingress_key ?? null
      ]
    )
    await client.query(
      `INSERT INTO executions
       (run_id,connector_id,status,input)
       VALUES ($1,$2,'pending',$3::jsonb)`,
      [
        run.run_id,
        this.connectorId,
        run.execution_input === undefined
          ? null
          : JSON.stringify(run.execution_input)
      ]
    )
    await client.query(
      `INSERT INTO preparations
       (run_id,connector_id,input_version,input,status,claim_token,claimed_at,attempt_count,started_at)
       VALUES ($1,$2,$3,$4::jsonb,'preparing',$5,clock_timestamp(),1,clock_timestamp())`,
      [
        run.run_id,
        this.connectorId,
        run.preparation_input_version ?? 'direct-v1',
        JSON.stringify(run.preparation_input ?? {}),
        preparationToken
      ]
    )
    await client.query(
      `INSERT INTO publications (run_id,connector_id,input,status)
       VALUES ($1,$2,$3::jsonb,'pending')`,
      [run.run_id, this.connectorId, JSON.stringify(run.publish_context)]
    )
    await appendEvent(client, {
      runId: run.run_id,
      connectorId: this.connectorId,
      axis: 'execution',
      fromStatus: null,
      toStatus: 'pending'
    })
    await appendEvent(client, {
      runId: run.run_id,
      connectorId: this.connectorId,
      axis: 'preparation',
      fromStatus: null,
      toStatus: 'preparing'
    })
    await appendEvent(client, {
      runId: run.run_id,
      connectorId: this.connectorId,
      axis: 'publication',
      fromStatus: null,
      toStatus: 'pending'
    })
    const record = await this.getWith(client, run.run_id)
    if (record === null)
      throw new Error(`Execution run was not persisted: ${run.run_id}`)
    return { record, created: true, preparation_token: preparationToken }
  }

  private async getWith(
    client: PoolClient,
    runId: string
  ): Promise<ReviewRunRecord | null> {
    const result = await client.query<ReviewRunRow>(
      `${RUN_SELECT}
       WHERE r.run_id=$1 AND r.connector_id=$2`,
      [runId, this.connectorId]
    )
    return result.rows[0] === undefined ? null : rowToRecord(result.rows[0])
  }

  private isIngressIdentityConflict(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505' &&
      'constraint' in error &&
      error.constraint === INGRESS_IDENTITY_CONSTRAINT
    )
  }
}
