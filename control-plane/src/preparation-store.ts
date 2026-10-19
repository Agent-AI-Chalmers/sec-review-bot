// Owns Control Plane's durable preparation work: claim leases, recoverable input
// checkpoints, retry exhaustion, and terminal-failure notification outbox state.
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

import type { ControlPlaneWorkflow as WorkflowName } from './contracts.js'
import { SUBMISSION_STATE_UNCERTAIN } from './errors.js'
import { appendEvent, appendEvents } from './review-run-events.js'
import { abandonInFlightPublication } from './publication-abandon.js'

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
       WHERE run_id=$1 AND connector_id=$2 AND status='preparing' AND claim_token=$3`,
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
         FROM preparations p
         JOIN review_runs r ON r.run_id=p.run_id AND r.connector_id=p.connector_id
         JOIN executions e ON e.run_id=p.run_id AND e.connector_id=p.connector_id
         WHERE p.connector_id=$1 AND p.status='pending'
           AND p.available_at <= clock_timestamp()
           AND p.input_version IS NOT NULL AND p.input IS NOT NULL
           AND e.status='pending'
         ORDER BY p.updated_at,p.run_id FOR UPDATE OF p SKIP LOCKED LIMIT 1`,
        [this.connectorId]
      )
      const work = candidate.rows[0]
      if (work === undefined) return null
      const token = crypto.randomUUID()
      // Claiming a retry starts a new attempt: both failure fields describe the attempt that
      // just ended, so they go back to NULL. `last_failure_code`/`last_failure_message` are the
      // durable record of what went wrong and are deliberately left alone, so a lease expiry
      // on this attempt can still tell the user the real reason.
      const claimed = await client.query(
        `UPDATE preparations SET status='preparing', claim_token=$2, claimed_at=clock_timestamp(),
           attempt_count=attempt_count+1, failure_code=NULL, failure_message=NULL,
           started_at=COALESCE(started_at, clock_timestamp()),
           updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$3 AND status='pending'`,
        [work.run_id, token, this.connectorId]
      )
      if (claimed.rowCount !== 1)
        throw new Error(`Preparation ${work.run_id} could not be claimed.`)
      await appendEvent(client, {
        runId: work.run_id,
        connectorId: this.connectorId,
        axis: 'preparation',
        fromStatus: 'pending',
        toStatus: 'preparing'
      })
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
       WHERE run_id=$1 AND connector_id=$2 AND status='preparing' AND claim_token=$3`,
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
        status: 'pending' | 'delivering'
      }>(
        `SELECT n.run_id,p.input,n.failure_code,n.status AS status
         FROM preparation_failure_notices n
         JOIN preparations p
           ON p.run_id=n.run_id AND p.connector_id=n.connector_id
         WHERE n.connector_id=$1 AND (n.status='pending' OR
           (n.status='delivering' AND n.claimed_at <= clock_timestamp()-($2*interval '1 millisecond')))
         ORDER BY n.updated_at,n.run_id FOR UPDATE OF n SKIP LOCKED LIMIT 1`,
        [this.connectorId, this.claimTimeoutMs]
      )
      const work = candidate.rows[0]
      if (work === undefined) return null
      const token = crypto.randomUUID()
      // Restate the claimable predicate instead of trusting the SELECT's row lock alone. The
      // lock makes this safe today, but repeating the condition (and returning the row) keeps
      // the event's `from_status` pinned to a state this UPDATE actually moved, exactly as
      // `claimNextPublicationOnce` does. `FOR UPDATE OF n` means the locked row cannot change
      // under us, so a mismatch is a bug rather than a race.
      const claimedNotice = await client.query<{
        status: 'pending' | 'delivering'
      }>(
        `UPDATE preparation_failure_notices
         SET status='delivering', claim_token=$2,
             claimed_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$3 AND status=$4
           AND ($4 <> 'delivering' OR claimed_at <= clock_timestamp()-($5*interval '1 millisecond'))
         RETURNING status`,
        [work.run_id, token, this.connectorId, work.status, this.claimTimeoutMs]
      )
      if (claimedNotice.rowCount !== 1)
        throw new Error(`Failure notice ${work.run_id} could not be claimed.`)
      // A notice is claimable while pending, or again once its delivery lease expired. The
      // event must name the state it actually came from, not assume pending.
      await appendEvent(client, {
        runId: work.run_id,
        connectorId: this.connectorId,
        axis: 'notice',
        fromStatus: work.status,
        toStatus: 'delivering',
        reasonCode: work.status === 'delivering' ? 'NOTICE_LEASE_EXPIRED' : null
      })
      return { ...work, claim_token: token }
    })
  }

  async completeFailureNotice(
    runId: string,
    token: string,
    delivered: boolean
  ): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE preparation_failure_notices SET status=$4, claim_token=NULL,
           claimed_at=NULL, updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='delivering' AND claim_token=$3`,
        [runId, this.connectorId, token, delivered ? 'delivered' : 'skipped']
      )
      if (result.rowCount !== 1) return false
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'notice',
        fromStatus: 'delivering',
        toStatus: delivered ? 'delivered' : 'skipped'
      })
      return true
    })
  }

  heartbeatIntervalMs(): number {
    return Math.max(1, Math.min(60_000, Math.floor(this.claimTimeoutMs / 3)))
  }

  async expireStale(): Promise<number> {
    return await transaction(this.pool, async (client) => {
      // One statement covers both expired outcomes: a retry returns the row to `pending` with the
      // phase still open, and an exhausted budget ends it as `failed`. Only the terminal branch
      // writes `finished_at`; omitting it there would leave a failed row that never recorded when
      // the phase ended.
      //
      // The terminal branch keeps a reason a previous attempt already recorded (for example
      // GITHUB_RATE_LIMITED) instead of overwriting it with the generic lease-expiry code: the
      // lease is what ended the phase, but the last real reason is what the user needs to see.
      // COALESCE covers the case where no attempt ever recorded one.
      const expired = await client.query<{
        run_id: string
        status: 'pending' | 'failed'
        failure_code: string | null
      }>(
        `UPDATE preparations
         SET status=CASE WHEN attempt_count >= $3 THEN 'failed' ELSE 'pending' END,
             claim_token=NULL, claimed_at=NULL, available_at=clock_timestamp(),
             failure_code=CASE WHEN attempt_count >= $3 THEN
               COALESCE(last_failure_code, 'PREPARATION_RETRY_EXHAUSTED') ELSE NULL END,
             failure_message=CASE WHEN attempt_count >= $3 THEN
               COALESCE(last_failure_message,
                 'Preparation claim lease expired after the retry budget was exhausted.') ELSE NULL END,
             finished_at=CASE WHEN attempt_count >= $3 THEN clock_timestamp() ELSE NULL END,
             updated_at=clock_timestamp()
         WHERE connector_id=$1 AND status='preparing'
           AND claimed_at <= clock_timestamp()-($2*interval '1 millisecond')
         RETURNING run_id, status, failure_code`,
        [this.connectorId, this.claimTimeoutMs, MAX_PREPARATION_ATTEMPTS]
      )
      // Preparation events for every expired row: a reversion to pending after the lease
      // lapsed, or a terminal failure once the retry budget is spent. The event names the code the
      // row now carries, which is the last real reason when a previous attempt recorded one.
      await appendEvents(
        client,
        expired.rows.map((row) => ({
          runId: row.run_id,
          connectorId: this.connectorId,
          axis: 'preparation' as const,
          fromStatus: 'preparing',
          toStatus: row.status,
          reasonCode: row.status === 'failed' ? row.failure_code : null
        }))
      )
      const failedRunIds = expired.rows
        .filter((row) => row.status === 'failed')
        .map((row) => row.run_id)
      if (failedRunIds.length === 0) return expired.rowCount ?? 0
      // Execution never ran, so it is skipped, not failed. The failure reason stays on the
      // preparation row (and is surfaced through the run's preparation summary).
      const failedRuns = await client.query<{ run_id: string }>(
        `UPDATE executions SET status='skipped',
           failure_code=NULL, failure_message=NULL,
           finished_at=clock_timestamp(),
           observed_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE run_id=ANY($1::text[]) AND connector_id=$2 AND status='pending' RETURNING run_id`,
        [failedRunIds, this.connectorId]
      )
      if (failedRuns.rowCount !== failedRunIds.length)
        throw new Error('Preparation expiry lost a terminal run transition.')
      await client.query(
        `UPDATE publications SET status='skipped', claim_token=NULL, failure_code=NULL,
           failure_message=NULL, finished_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE run_id=ANY($1::text[]) AND connector_id=$2 AND status='pending'`,
        [failedRunIds, this.connectorId]
      )
      // The notice carries the reason the preparation row now holds, so a lease expiry after a
      // real failure (for example rate limiting) reports that failure instead of the generic
      // exhaustion code.
      await client.query(
        `INSERT INTO preparation_failure_notices (run_id,connector_id,status,failure_code)
         SELECT p.run_id,p.connector_id,'pending',p.failure_code
         FROM preparations p
         WHERE p.run_id=ANY($1::text[]) AND p.connector_id=$2
         ON CONFLICT (run_id) DO NOTHING`,
        [failedRunIds, this.connectorId]
      )
      await appendEvents(
        client,
        failedRunIds.flatMap((failedRunId) => [
          {
            runId: failedRunId,
            connectorId: this.connectorId,
            axis: 'runner' as const,
            fromStatus: 'pending',
            toStatus: 'skipped'
          },
          {
            runId: failedRunId,
            connectorId: this.connectorId,
            axis: 'publication' as const,
            fromStatus: 'pending',
            toStatus: 'skipped'
          },
          {
            runId: failedRunId,
            connectorId: this.connectorId,
            axis: 'notice' as const,
            fromStatus: null,
            toStatus: 'pending'
          }
        ])
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
          // A retry records the reason on the row (for the operator reading the current
          // state) and in `last_failure_*` (for a later lease expiry, which outlives the claim
          // that clears `failure_code`).
          `UPDATE preparations SET status='pending', claim_token=NULL, claimed_at=NULL,
             available_at=clock_timestamp() + ($4::bigint * interval '1 millisecond'),
             failure_code=$5, failure_message=$6,
             last_failure_code=$5, last_failure_message=$6, updated_at=clock_timestamp()
           WHERE run_id=$1 AND connector_id=$2 AND status='preparing' AND claim_token=$3
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
        if (retry.rowCount === 1) {
          await appendEvent(client, {
            runId,
            connectorId: this.connectorId,
            axis: 'preparation',
            fromStatus: 'preparing',
            toStatus: 'pending',
            reasonCode: error.code ?? null
          })
          return { retry_scheduled: true }
        }
      }
      // Whether execution is "uncertain" or "skipped" depends on whether the Runner may have
      // been reached. An uncertain submission may have been accepted but unconfirmed, so
      // execution is `uncertain` (a recovery replays it) — not a failure. Any other terminal
      // preparation failure means the Runner was never called, so execution is `skipped`.
      // Matching the shared constant keeps this in step with the submission paths that stamp it.
      const submissionUncertain = error.code === SUBMISSION_STATE_UNCERTAIN
      // An `uncertain` execution deliberately keeps `started_at` NULL: the submission may never
      // have been accepted, so the phase has not provably begun. `completeSubmissionRecovery`
      // fills the start once a replay is accepted; do not set it here.
      const result = submissionUncertain
        ? await client.query(
            `UPDATE executions SET status='uncertain',
               failure_code=$4, failure_message=$5,
               observed_at=clock_timestamp(), updated_at=clock_timestamp()
             WHERE run_id=$1 AND connector_id=$2 AND status='pending' AND EXISTS (
               SELECT 1 FROM preparations WHERE preparations.run_id=executions.run_id
                 AND preparations.connector_id=$2 AND preparations.status='preparing' AND preparations.claim_token=$3)`,
            [runId, this.connectorId, token, error.code, error.message]
          )
        : await client.query(
            `UPDATE executions SET status='skipped',
               failure_code=NULL, failure_message=NULL,
               finished_at=clock_timestamp(),
               observed_at=clock_timestamp(), updated_at=clock_timestamp()
             WHERE run_id=$1 AND connector_id=$2 AND status='pending' AND EXISTS (
               SELECT 1 FROM preparations WHERE preparations.run_id=executions.run_id
                 AND preparations.connector_id=$2 AND preparations.status='preparing' AND preparations.claim_token=$3)`,
            [runId, this.connectorId, token]
          )
      if (result.rowCount !== 1)
        throw new Error(
          `Preparation claim was lost before failing review run ${runId}.`
        )
      // The executions update above proves the claim was live when it ran, but the preparation
      // row is only read through an EXISTS there, not locked. Under READ COMMITTED another writer
      // (an expired lease in `expireStale`) can still replace the row between the two statements.
      // Without this check the transaction would keep going and record `preparing -> failed` while
      // the snapshot says something else, so the log and the state would disagree. Throwing rolls
      // back the whole cross-axis failure instead of committing it on a stale claim.
      const prepared = await client.query(
        `UPDATE preparations SET status='failed', claim_token=NULL, claimed_at=NULL,
           failure_code=$4, failure_message=$5,
           last_failure_code=$4, last_failure_message=$5,
           finished_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='preparing' AND claim_token=$3`,
        [runId, this.connectorId, token, error.code ?? null, error.message]
      )
      if (prepared.rowCount !== 1)
        throw new Error(
          `Preparation ${runId} lost its claim before it could be marked failed.`
        )
      // Publication is only "not applicable" once execution is conclusively skipped. An
      // uncertain submission may still be accepted, so its publication stays `pending`: ruling
      // it out early would require a later skipped -> pending reversion just to undo this.
      const skippedPublicationFrom = submissionUncertain
        ? null
        : await abandonInFlightPublication(client, this.connectorId, runId)
      await client.query(
        `INSERT INTO preparation_failure_notices (run_id,connector_id,status,failure_code)
         VALUES ($1,$2,'pending',$3) ON CONFLICT (run_id) DO NOTHING`,
        [runId, this.connectorId, error.code ?? null]
      )
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'preparation',
        fromStatus: 'preparing',
        toStatus: 'failed',
        reasonCode: error.code ?? null
      })
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'runner',
        fromStatus: 'pending',
        toStatus: submissionUncertain ? 'uncertain' : 'skipped',
        reasonCode: submissionUncertain ? SUBMISSION_STATE_UNCERTAIN : null
      })
      if (skippedPublicationFrom !== null) {
        await appendEvent(client, {
          runId,
          connectorId: this.connectorId,
          axis: 'publication',
          fromStatus: skippedPublicationFrom,
          toStatus: 'skipped',
          reasonCode: 'PUBLICATION_ABANDONED'
        })
      }
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'notice',
        fromStatus: null,
        toStatus: 'pending'
      })
      return { retry_scheduled: false }
    })
  }
}
