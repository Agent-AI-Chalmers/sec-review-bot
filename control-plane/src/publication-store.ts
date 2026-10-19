// Owns the single-axis publication writes: lease renewal, completion, failure, and per-step
// progress. These only touch `publications` / `publication_steps`, so `ReviewRunStore` forwards
// to them unchanged.
//
// Claiming is deliberately NOT here. Selecting publishable work requires the execution axis
// (`executions.status='succeeded'` and a non-null workflow_result) and returns a full
// cross-axis record, so it lives in `ReviewRunStore` as cross-axis orchestration rather than as
// a single-axis write. Do not reintroduce a publication-only claim here: a version that
// duplicated the SQL without a caller is what this comment replaces.
import { Pool, type PoolClient } from 'pg'

import {
  DeterministicControlPlaneError,
  PUBLICATION_STEP_ERROR_CODES
} from './errors.js'
import type { PublicationStepRecord } from './shapes.js'
import { appendEvent } from './review-run-events.js'

const MAX_PUBLICATION_STEP_FAILURES = 3

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

export class PublicationStore {
  constructor(
    private readonly pool: Pool,
    private readonly connectorId: string,
    private readonly claimTimeoutMs: number
  ) {}

  heartbeatIntervalMs(): number {
    return Math.max(100, Math.min(30_000, Math.floor(this.claimTimeoutMs / 3)))
  }

  async renewClaim(runId: string, token: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE publications SET claimed_at=clock_timestamp(), updated_at=clock_timestamp()
       WHERE run_id=$1 AND connector_id=$2 AND status='publishing' AND claim_token=$3`,
      [runId, this.connectorId, token]
    )
    return result.rowCount === 1
  }

  async complete(runId: string, token: string): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE publications SET status='published', claim_token=NULL, published_at=clock_timestamp(),
           failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='publishing' AND claim_token=$3
           AND NOT EXISTS (SELECT 1 FROM publication_steps
             WHERE run_id=$1 AND connector_id=$2 AND status <> 'succeeded')`,
        [runId, this.connectorId, token]
      )
      if (result.rowCount !== 1) return false
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'publication',
        fromStatus: 'publishing',
        toStatus: 'published'
      })
      return true
    })
  }

  async fail(
    runId: string,
    token: string,
    error: { code?: string | null; message: string },
    options: { retry: boolean }
  ): Promise<boolean> {
    const toStatus = options.retry ? 'pending' : 'failed'
    return await transaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE publications SET status=$4, claim_token=NULL, failure_code=$5,
           failure_message=$6, updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='publishing' AND claim_token=$3`,
        [
          runId,
          this.connectorId,
          token,
          toStatus,
          error.code ?? null,
          error.message
        ]
      )
      if (result.rowCount !== 1) return false
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'publication',
        fromStatus: 'publishing',
        toStatus,
        reasonCode: error.code ?? null
      })
      return true
    })
  }
  async initializePublicationSteps(
    runId: string,
    token: string,
    stepKeys: string[]
  ): Promise<void> {
    const uniqueKeys = [...new Set(stepKeys)].sort()
    if (uniqueKeys.length !== stepKeys.length)
      throw new DeterministicControlPlaneError(
        `Publication ${runId} contains duplicate step keys.`,
        PUBLICATION_STEP_ERROR_CODES.set_duplicate
      )
    await transaction(this.pool, async (client) => {
      const owner = await client.query(
        `
        SELECT 1 FROM publications
        WHERE run_id=$1 AND connector_id=$2
          AND status='publishing' AND claim_token=$3
        FOR UPDATE
      `,
        [runId, this.connectorId, token]
      )
      if (owner.rowCount !== 1)
        throw new Error(
          `Publication claim was lost before steps were initialized: ${runId}`
        )
      const existing = await client.query<{ step_key: string }>(
        `
        SELECT step_key FROM publication_steps
        WHERE run_id=$1 AND connector_id=$2
        ORDER BY step_key
      `,
        [runId, this.connectorId]
      )
      if (existing.rowCount === 0) {
        for (const stepKey of uniqueKeys) {
          await client.query(
            `
            INSERT INTO publication_steps (connector_id,run_id,step_key,status)
            VALUES ($1,$2,$3,'pending')
          `,
            [this.connectorId, runId, stepKey]
          )
        }
        return
      }
      const persisted = existing.rows.map((row) => row.step_key).sort()
      if (JSON.stringify(persisted) !== JSON.stringify(uniqueKeys)) {
        throw new DeterministicControlPlaneError(
          `Publication step set changed for run ${runId}.`,
          PUBLICATION_STEP_ERROR_CODES.set_changed
        )
      }
    })
  }
  async listPublicationSteps(runId: string): Promise<PublicationStepRecord[]> {
    const result = await this.pool.query<PublicationStepRecord>(
      `
      SELECT step_key,status,failure_count,remote_object_id,remote_object_url,
             failure_code,failure_message
      FROM publication_steps
      WHERE run_id=$1 AND connector_id=$2
      ORDER BY step_key
    `,
      [runId, this.connectorId]
    )
    return result.rows
  }
  private async claimPublicationStep(
    runId: string,
    token: string,
    stepKey: string
  ): Promise<boolean> {
    // A running step may belong to the expired publication owner. The new
    // owner reclaims it under the new publication token, then reconciles the
    // stable remote identity before issuing another side effect.
    const result = await this.pool.query(
      `
      UPDATE publication_steps s
      SET status='running', updated_at=clock_timestamp()
      FROM publications p
      WHERE s.run_id=$1 AND s.connector_id=$2 AND s.step_key=$3
        AND (s.status IN ('pending','running') OR (s.status='failed' AND s.failure_count<$5))
        AND p.run_id=s.run_id AND p.connector_id=s.connector_id
        AND p.status='publishing' AND p.claim_token=$4
    `,
      [runId, this.connectorId, stepKey, token, MAX_PUBLICATION_STEP_FAILURES]
    )
    return result.rowCount === 1
  }
  async requirePublicationStepClaim(
    runId: string,
    token: string,
    stepKey: string
  ): Promise<void> {
    if (await this.claimPublicationStep(runId, token, stepKey)) return

    // Retry exhaustion is a persisted step outcome, not merely an exception
    // observed by one publisher. The current publication owner records it once.
    await this.pool.query(
      `
      UPDATE publication_steps s
      SET status='terminal_failed', updated_at=clock_timestamp()
      FROM publications p
      WHERE s.run_id=$1 AND s.connector_id=$2 AND s.step_key=$3
        AND s.status='failed' AND s.failure_count>=$5
        AND p.run_id=s.run_id AND p.connector_id=s.connector_id
        AND p.status='publishing' AND p.claim_token=$4
    `,
      [runId, this.connectorId, stepKey, token, MAX_PUBLICATION_STEP_FAILURES]
    )
    const step = (await this.listPublicationSteps(runId)).find(
      (item) => item.step_key === stepKey
    )
    if (step?.status === 'terminal_failed') {
      throw new DeterministicControlPlaneError(
        `Publication step exhausted its retry budget: ${stepKey}`,
        PUBLICATION_STEP_ERROR_CODES.retry_exhausted
      )
    }
    throw new DeterministicControlPlaneError(
      `Publication step is not claimable: ${stepKey}`,
      PUBLICATION_STEP_ERROR_CODES.not_claimable
    )
  }
  async completePublicationStep(
    runId: string,
    token: string,
    stepKey: string,
    remote: { id?: string | null; url?: string | null } = {}
  ): Promise<boolean> {
    // A publication token fences every step commit, not only the final run
    // state. This prevents a timed-out worker from recording stale remote data.
    const result = await this.pool.query(
      `
      UPDATE publication_steps s
      SET status='succeeded', remote_object_id=$5, remote_object_url=$6,
          failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
      FROM publications p
      WHERE s.run_id=$1 AND s.connector_id=$2 AND s.step_key=$3 AND s.status='running'
        AND p.run_id=s.run_id AND p.connector_id=s.connector_id
        AND p.status='publishing' AND p.claim_token=$4
    `,
      [
        runId,
        this.connectorId,
        stepKey,
        token,
        remote.id ?? null,
        remote.url ?? null
      ]
    )
    return result.rowCount === 1
  }
  async failPublicationStep(
    runId: string,
    token: string,
    stepKey: string,
    error: { code?: string | null; message: string },
    options: { retry?: boolean } = {}
  ): Promise<boolean> {
    const result = await this.pool.query(
      `
      UPDATE publication_steps s
      SET status=$7, failure_count=s.failure_count+1,
          failure_code=$5, failure_message=$6, updated_at=clock_timestamp()
      FROM publications p
      WHERE s.run_id=$1 AND s.connector_id=$2 AND s.step_key=$3 AND s.status='running'
        AND p.run_id=s.run_id AND p.connector_id=s.connector_id
        AND p.status='publishing' AND p.claim_token=$4
    `,
      [
        runId,
        this.connectorId,
        stepKey,
        token,
        error.code ?? null,
        error.message,
        options.retry === false ? 'terminal_failed' : 'failed'
      ]
    )
    return result.rowCount === 1
  }
}
