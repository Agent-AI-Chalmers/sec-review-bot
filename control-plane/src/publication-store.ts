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
        `UPDATE publications SET status='published', claim_token=NULL,
           finished_at=clock_timestamp(),
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

  /** Record a publication failure.
   *
   * Only a terminal failure ends the phase, so only it writes `finished_at`; a retryable failure
   * returns the row to `pending` to be claimed again, and clearing the end keeps "this phase has
   * not finished" true. */
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
           failure_message=$6,
           finished_at=CASE WHEN $4='failed' THEN clock_timestamp() ELSE NULL END,
           updated_at=clock_timestamp()
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
      // A terminal publication failure ends the run. The requester is told about it here, not
      // only when an individual step happens to be marked terminal: the coordinator can conclude
      // the whole publication without going through `failPublicationStep`.
      if (toStatus === 'failed') {
        await client.query(
          `INSERT INTO run_failure_notices (run_id,connector_id,status,failure_stage,failure_code)
           VALUES ($1,$2,'pending','publication',$3) ON CONFLICT (run_id) DO NOTHING`,
          [runId, this.connectorId, error.code ?? null]
        )
      }
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
    const result = await this.pool.query<
      Omit<PublicationStepRecord, 'last_attempt_at'> & {
        last_attempt_at: Date | string | null
      }
    >(
      `
      SELECT step_key,status,attempt_count,last_attempt_at,failure_count,
             remote_object_id,remote_object_url,failure_code,failure_message
      FROM publication_steps
      WHERE run_id=$1 AND connector_id=$2
      ORDER BY step_key
    `,
      [runId, this.connectorId]
    )
    // `last_attempt_at` is a timestamptz, which node-pg hands back as a Date; the contract
    // declares it a date-time string like every other timestamp on the read surface.
    return result.rows.map((row) => ({
      ...row,
      last_attempt_at:
        row.last_attempt_at === null
          ? null
          : row.last_attempt_at instanceof Date
            ? row.last_attempt_at.toISOString()
            : row.last_attempt_at
    }))
  }
  private async claimPublicationStep(
    runId: string,
    token: string,
    stepKey: string
  ): Promise<boolean> {
    // A `running` step may belong to a publisher that died mid-effect. This update reclaims it
    // under the new publication token but deliberately does NOT decide whether the side effect
    // already happened: it cannot know. Instead it records that a new attempt started, so the
    // caller can see `attempt_count > 1` and reconcile against the remote object before issuing
    // another call. Assuming a reclaim means "nothing happened yet" is what would duplicate a
    // comment or a pull request.
    const result = await this.pool.query(
      `
      UPDATE publication_steps s
      SET status='running', claimed_by=$4, attempt_count=s.attempt_count+1,
          last_attempt_at=clock_timestamp(), updated_at=clock_timestamp()
      FROM publications p
      WHERE s.run_id=$1 AND s.connector_id=$2 AND s.step_key=$3
        AND (
          s.status='pending'
          -- A step left running belongs to an owner that may have died mid-effect. Only a
          -- different token may take it over: the same owner claiming its own running step
          -- would start a second attempt for one side effect, which is precisely what the
          -- attempt count is supposed to make visible rather than corrupt.
          OR (s.status='running' AND s.claimed_by IS DISTINCT FROM $4::uuid)
          OR (s.status='failed' AND s.failure_count<$5)
        )
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
      SET status='succeeded', claimed_by=NULL,
          remote_object_id=$5, remote_object_url=$6,
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
    const terminal = options.retry === false
    return await transaction(this.pool, async (client) => {
      const result = await client.query(
        `
        UPDATE publication_steps s
        SET status=$7, claimed_by=NULL, failure_count=s.failure_count+1,
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
          terminal ? 'terminal_failed' : 'failed'
        ]
      )
      if (result.rowCount !== 1) return false
      // Only a terminal step failure ends the run. A step that is going to be retried is not
      // news for the requester yet, and announcing it would produce a reply per attempt.
      if (terminal) {
        await client.query(
          `INSERT INTO run_failure_notices (run_id,connector_id,status,failure_stage,failure_code)
           VALUES ($1,$2,'pending','publication',$3) ON CONFLICT (run_id) DO NOTHING`,
          [runId, this.connectorId, error.code ?? null]
        )
      }
      return true
    })
  }
}
