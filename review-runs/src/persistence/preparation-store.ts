// Owns Review Runs's durable preparation work: claim leases, recoverable input
// checkpoints, retry exhaustion, and terminal-failure notification outbox state.
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import type { Database } from '../database/database.js'

import type { PreparationWork as ContractPreparationWork } from '../contract-types-generated.js'
import type { ReviewRunWorkflow as WorkflowName } from '../contracts.js'
import { transaction } from '../database/transaction.js'
import { SUBMISSION_STATE_UNCERTAIN } from '../errors.js'
import { appendEvent } from './review-run-events.js'
import {
  abandonInFlightPublication,
  abandonInFlightPublications
} from './publication-abandon.js'
import { skipPendingExecutions } from './execution-skip.js'
import { queueRunNotice } from './run-notices.js'
import type { RunNoticeWork } from '../shapes.js'

type JsonObject = Record<string, unknown>

// The claimed work is a cross-service message, so its field set belongs to the contract. Nothing
// Review Runs needs only internally may be added here: a field on this type is published to
// the connector, and a published field the connector never reads is a contract obligation nobody
// honours. The claim's origin state is exactly that - it is read below to name the audit event and
// must stay out of the returned message.
export type PreparationWork = ContractPreparationWork

// The notice is a cross-service message, so its field set belongs to the contract and is
// re-exported rather than restated; a local copy would drift from the schema the connector reads.
export type { RunNoticeWork }

/** One run whose expired lease could not be concluded, and why.
 *
 * `reason` is a stable code, not a sentence, so a log consumer or alert can group these rows
 * without parsing English. Today the only case is an execution axis that already left `pending`,
 * which a preparation failure can no longer explain. */
export interface PreparationExpiryBlocked {
  run_id: string
  reason: 'EXECUTION_ALREADY_ADVANCED'
}

/** Outcome of one expiry pass: rows concluded, and rows durably marked as needing repair. */
export interface PreparationExpiryResult {
  concluded: number
  blocked: PreparationExpiryBlocked[]
}

/** Raised inside a per-row savepoint when the row's persisted story is self-contradictory.
 *
 * It is not a transient fault: retrying the same row would fail identically forever, so the
 * caller rolls the savepoint back, records the block, and lets the rest of the pass proceed. */
class ExpiryUnreconcilableError extends Error {
  constructor(
    readonly reason: PreparationExpiryBlocked['reason'],
    message: string
  ) {
    super(message)
    this.name = 'ExpiryUnreconcilableError'
  }
}

const MAX_PREPARATION_ATTEMPTS = 8

export class PreparationStore {
  /** The pool, guarded by the database's readiness check. */
  protected get pool(): Pool {
    return this.database.pool()
  }

  constructor(
    private readonly database: Database,
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
      // `from_status` is read so the audit event can name the real origin of the claim; it is
      // deliberately not part of `PreparationWork`, which is the connector-facing message.
      const candidate = await client.query<{
        run_id: string
        workflow: WorkflowName
        input_version: string
        input: JsonObject
        attempt_count: number
        from_status: 'pending' | 'uncertain'
      }>(
        `SELECT p.run_id,r.workflow,p.input_version,p.input,p.attempt_count,
                p.status AS from_status
         FROM preparations p
         JOIN review_runs r ON r.run_id=p.run_id AND r.connector_id=p.connector_id
         JOIN executions e ON e.run_id=p.run_id AND e.connector_id=p.connector_id
         -- uncertain is claimable alongside pending: a pending row has never been worked, while an
         -- uncertain one may already have handed its input over, so a claim on it starts a new
         -- attempt rather than a first one. The difference is Review Runs's own bookkeeping, so
         -- it stays here instead of travelling to the connector.
         WHERE p.connector_id=$1 AND p.status IN ('pending','uncertain')
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
         WHERE run_id=$1 AND connector_id=$3 AND status=$4`,
        [work.run_id, token, this.connectorId, work.from_status]
      )
      if (claimed.rowCount !== 1)
        throw new Error(`Preparation ${work.run_id} could not be claimed.`)
      await appendEvent(client, {
        runId: work.run_id,
        connectorId: this.connectorId,
        axis: 'preparation',
        fromStatus: work.from_status,
        toStatus: 'preparing'
      })
      // Built field by field so only the contract's fields leave this store: `from_status` was
      // read for the event above and is Review Runs's own bookkeeping.
      return {
        run_id: work.run_id,
        workflow: work.workflow,
        input_version: work.input_version,
        input: work.input,
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

  /** Claim the oldest deliverable notice for this connector.
   *
   * Delivery is a connector capability, not a per-process one: the oldest pending (or lapsed
   * `delivering`) notice wins, whoever asks. That is deliberate - one outbox per connector is
   * what lets "the requester was told" be a single fact rather than a race between processes -
   * but it carries an assumption the claim cannot check: every process that runs this claim
   * holds the GitHub App credentials the reply needs. A process that does not will take the
   * notice, fail to reach the installation, and conclude it undelivered, which is wrong but not
   * recoverable by retrying; `apps/github-integration` pins that consequence in
   * `preparation-coordinator.test.ts`.
   *
   * If a deployment ever runs a notice-less role under the same connector, the fix is a role or
   * capability field on this claim, not a second queue: a second queue would split the very
   * fact it exists to keep single. */
  async claimNextRunNotice(): Promise<RunNoticeWork | null> {
    return await transaction(this.pool, async (client) => {
      const candidate = await client.query<{
        notice_id: string
        run_id: string
        input: JsonObject
        kind: 'failure' | 'attention'
        axis: 'preparation' | 'execution' | 'publication'
        reason_code: string | null
        status: 'pending' | 'delivering'
      }>(
        // The run's input lives on the preparation row: it is `NOT NULL` there and no path
        // deletes that row, so an execution- or publication-originated notice still finds it.
        // Reading it from the other axes was defensive code with nothing to defend against.
        // The join stays `LEFT` on purpose - a notice whose preparation row is somehow missing
        // must still be delivered, with an empty input rather than not at all.
        `SELECT n.notice_id,n.run_id,COALESCE(p.input,'{}'::jsonb) AS input,
                n.kind,n.axis,n.reason_code,n.status AS status
         FROM run_notices n
         LEFT JOIN preparations p
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
        `UPDATE run_notices
         SET status='delivering', claim_token=$2,
             claimed_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE notice_id=$1 AND connector_id=$3 AND status=$4
           AND ($4 <> 'delivering' OR claimed_at <= clock_timestamp()-($5*interval '1 millisecond'))
         RETURNING status`,
        [
          work.notice_id,
          token,
          this.connectorId,
          work.status,
          this.claimTimeoutMs
        ]
      )
      if (claimedNotice.rowCount !== 1)
        throw new Error(`Run notice ${work.notice_id} could not be claimed.`)
      return { ...work, claim_token: token }
    })
  }

  async completeRunNotice(
    noticeId: string,
    token: string,
    delivered: boolean,
    /** The comment the requester can read. Required for a delivery, rejected without one. */
    commentUrl?: string | null
  ): Promise<boolean> {
    if (delivered && (commentUrl === undefined || commentUrl === null)) {
      // A delivered notice with nowhere to point would claim the requester was told while giving
      // no way to verify it, so the caller's mistake is surfaced instead of stored.
      throw new Error(
        `Run notice ${noticeId} cannot be delivered without a comment_url.`
      )
    }
    if (!delivered && commentUrl !== undefined && commentUrl !== null) {
      // The other half of the same contract: an undelivered notice has no destination, so a URL
      // here means the caller believes something was posted. Discarding it silently would hide
      // that disagreement.
      throw new Error(
        `Run notice ${noticeId} cannot carry a comment_url when delivery failed.`
      )
    }
    return await transaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE run_notices SET status=$4, claim_token=NULL,
           claimed_at=NULL, comment_url=$5, updated_at=clock_timestamp()
         WHERE notice_id=$1 AND connector_id=$2 AND status='delivering' AND claim_token=$3`,
        // `failed`, not `skipped`: the connector attempted delivery and could not complete it.
        [
          noticeId,
          this.connectorId,
          token,
          delivered ? 'delivered' : 'failed',
          commentUrl ?? null
        ]
      )
      return result.rowCount === 1
    })
  }

  async renewRunNoticeClaim(noticeId: string, token: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE run_notices
       SET claimed_at=clock_timestamp(), updated_at=clock_timestamp()
       WHERE notice_id=$1 AND connector_id=$2 AND status='delivering' AND claim_token=$3`,
      [noticeId, this.connectorId, token]
    )
    return result.rowCount === 1
  }

  heartbeatIntervalMs(): number {
    return Math.max(1, Math.min(60_000, Math.floor(this.claimTimeoutMs / 3)))
  }

  /** Conclude preparation leases that have expired.
   *
   * Each expired row is processed in its own savepoint so one unreconcilable run cannot abort
   * the whole pass. Before this, a single row whose persisted story contradicted itself made the
   * shared transaction throw, and since coordination calls this first, *every* pass rolled back
   * before recovering submissions or observing active runs: one corrupt run starved all the
   * others, forever, with the same error on each tick.
   *
   * Returns the number of rows whose expiry was concluded, plus the rows that were skipped
   * because they could not be reconciled. The skipped ones are durably marked
   * (`expiry_blocked_reason`) so later passes do not retry a transition that must keep failing;
   * they stay visible for repair instead of silently disappearing. */
  async expireStale(): Promise<PreparationExpiryResult> {
    return await transaction(this.pool, async (client) => {
      // Candidate selection is deliberately separate from the conclusion below: the conclusion
      // needs a per-row savepoint to isolate failures, which a single set-based UPDATE cannot
      // provide.
      const candidates = await client.query<{
        run_id: string
        attempt_count: number
      }>(
        `SELECT run_id, attempt_count FROM preparations
         WHERE connector_id=$1 AND status='preparing'
           AND claimed_at <= clock_timestamp()-($2*interval '1 millisecond')
         ORDER BY updated_at, run_id
         FOR UPDATE SKIP LOCKED`,
        [this.connectorId, this.claimTimeoutMs]
      )

      let concluded = 0
      const blocked: PreparationExpiryBlocked[] = []
      for (const candidate of candidates.rows) {
        const savepoint = `expire_${candidate.run_id.replace(/[^a-zA-Z0-9_]/g, '_')}`
        await client.query(`SAVEPOINT ${savepoint}`)
        try {
          await this.concludeExpiry(
            client,
            candidate.run_id,
            candidate.attempt_count
          )
          await client.query(`RELEASE SAVEPOINT ${savepoint}`)
          concluded += 1
        } catch (error) {
          if (!(error instanceof ExpiryUnreconcilableError)) throw error
          // Roll the row's partial writes back before recording why it was left alone. The block
          // marker itself must survive, which is why it is written after the rollback rather than
          // inside the aborted savepoint.
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
          // Disconnecting is itself a transition, so it is audited like any other and named in
          // the same vocabulary the console and the operator queue read.
          const disconnected = await client.query(
            `UPDATE preparations
             SET status='disconnected', disconnect_reason=$3,
                 claim_token=NULL, claimed_at=NULL, updated_at=clock_timestamp()
             WHERE run_id=$1 AND connector_id=$2 AND status='preparing'`,
            [candidate.run_id, this.connectorId, error.reason]
          )
          if (disconnected.rowCount === 1) {
            const eventId = await appendEvent(client, {
              runId: candidate.run_id,
              connectorId: this.connectorId,
              axis: 'preparation',
              fromStatus: 'preparing',
              toStatus: 'disconnected',
              reasonCode: error.reason
            })
            await queueRunNotice(client, {
              runId: candidate.run_id,
              connectorId: this.connectorId,
              sourceEventId: eventId,
              kind: 'attention',
              axis: 'preparation',
              reasonCode: error.reason
            })
          }
          blocked.push({ run_id: candidate.run_id, reason: error.reason })
          await client.query(`RELEASE SAVEPOINT ${savepoint}`)
        }
      }
      return { concluded, blocked }
    })
  }

  /** Conclude one expired preparation row, in the caller's transaction.
   *
   * An expired lease means the preparer is gone and nobody knows how far it got, so the row does
   * not go back to `pending`: `pending` says "not started", and a claim on it would rebuild and
   * resubmit on the assumption that nothing happened. It goes to `uncertain` instead — automatic
   * work may continue, but only after establishing what the previous owner left behind — and
   * only an exhausted budget ends it as `failed`.
   *
   * Throws `ExpiryUnreconcilableError` when the execution axis has moved past `pending`: that is
   * the case a preparation conclusion can no longer explain, because the input did reach the
   * Execution after all. Writing the "execution never ran" conclusion then would overwrite a real
   * result, so the caller rolls this row back and disconnects it for an operator instead. */
  private async concludeExpiry(
    client: PoolClient,
    runId: string,
    attemptCount: number
  ): Promise<void> {
    const exhausted = attemptCount >= MAX_PREPARATION_ATTEMPTS
    // One statement covers both expired outcomes: the lease lapse makes the row `uncertain` with
    // the phase still open, and an exhausted budget ends it as `failed`. Only the terminal branch
    // writes `finished_at` and a reason. The terminal reason keeps whatever a previous attempt
    // recorded (for example GITHUB_RATE_LIMITED) instead of overwriting it with the generic
    // exhaustion code: the lease is what ended the phase, but the last real reason is what the
    // user needs to see.
    const expired = await client.query<{
      run_id: string
      status: 'uncertain' | 'failed'
      failure_code: string | null
    }>(
      `UPDATE preparations
       SET status=CASE WHEN $3::boolean THEN 'failed' ELSE 'uncertain' END,
           claim_token=NULL, claimed_at=NULL, available_at=clock_timestamp(),
           failure_code=CASE WHEN $3::boolean THEN
             COALESCE(last_failure_code, 'PREPARATION_RETRY_EXHAUSTED') ELSE NULL END,
           failure_message=CASE WHEN $3::boolean THEN
             COALESCE(last_failure_message,
               'Preparation claim lease expired after the retry budget was exhausted.') ELSE NULL END,
           finished_at=CASE WHEN $3::boolean THEN clock_timestamp() ELSE NULL END,
           updated_at=clock_timestamp()
       WHERE run_id=$1 AND connector_id=$2 AND status='preparing'
       RETURNING run_id, status, failure_code`,
      [runId, this.connectorId, exhausted]
    )
    const row = expired.rows[0]
    if (row === undefined)
      throw new Error(`Expired preparation ${runId} could not be concluded.`)
    const preparationEventId = await appendEvent(client, {
      runId,
      connectorId: this.connectorId,
      axis: 'preparation',
      fromStatus: 'preparing',
      toStatus: row.status,
      reasonCode: row.status === 'failed' ? row.failure_code : null
    })
    if (row.status !== 'failed') return

    // Execution never ran, so it is skipped, not failed. The failure reason stays on the
    // preparation row (and is surfaced through the run's preparation summary). A run whose
    // execution already left `pending` contradicts that premise: refuse to overwrite it.
    const skippedRuns = await skipPendingExecutions(client, this.connectorId, [
      runId
    ])
    if (skippedRuns.length !== 1)
      throw new ExpiryUnreconcilableError(
        'EXECUTION_ALREADY_ADVANCED',
        `preparation ${runId} expired with its execution no longer pending`
      )
    // Publication is not applicable either; the helper converges an in-flight publication too.
    const abandoned = await abandonInFlightPublications(
      client,
      this.connectorId,
      [runId]
    )
    await queueRunNotice(client, {
      runId,
      connectorId: this.connectorId,
      sourceEventId: preparationEventId,
      kind: 'failure',
      axis: 'preparation',
      reasonCode: row.failure_code
    })
    await appendEvent(client, {
      runId,
      connectorId: this.connectorId,
      axis: 'execution',
      fromStatus: 'pending',
      toStatus: 'skipped'
    })
    const publicationFrom = abandoned.get(runId)
    if (publicationFrom !== undefined) {
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'publication',
        fromStatus: publicationFrom,
        toStatus: 'skipped',
        reasonCode: 'PUBLICATION_ABANDONED'
      })
    }
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
      // Whether execution is "uncertain" or "skipped" depends on whether the Execution may have
      // been reached. An uncertain submission may have been accepted but unconfirmed, so
      // execution is `uncertain` (a recovery replays it) — not a failure. Any other terminal
      // preparation failure means the Execution was never called, so execution is `skipped`.
      // Matching the shared constant keeps this in step with the submission paths that stamp it.
      const submissionUncertain = error.code === SUBMISSION_STATE_UNCERTAIN
      // Close the preparation row first. This UPDATE is also the claim check: it only matches
      // while the row is still `preparing` under our token, so a lease that expired between the
      // claim and here makes it match nothing. Doing it before the execution write means the
      // execution write no longer has to repeat the claim EXISTS, and a lost claim aborts before
      // any other axis is touched.
      const prepared = await client.query(
        `UPDATE preparations SET status='failed', claim_token=NULL, claimed_at=NULL,
           failure_code=$4, failure_message=$5,
           last_failure_code=$4, last_failure_message=$5,
           finished_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='preparing' AND claim_token=$3`,
        [runId, this.connectorId, token, error.code ?? null, error.message]
      )
      if (prepared.rowCount !== 1)
        // Losing the compare-and-set is the expected result when a lease expiry or another
        // owner concludes this preparation first. The token fence did its job: this caller must
        // not write a second terminal transition, but it also must not turn the winner's valid
        // transition into a server error. `false` means that this invocation scheduled no retry;
        // the durable row and its audit event belong to whichever owner won the fence.
        return { retry_scheduled: false }
      // An `uncertain` execution deliberately keeps `started_at` NULL: the submission may never
      // have been accepted, so the phase has not provably begun. `completeSubmissionRecovery`
      // fills the start once a replay is accepted; do not set it here.
      const result = submissionUncertain
        ? await client.query(
            `UPDATE executions SET status='uncertain',
               failure_code=$3, failure_message=$4,
               observed_at=clock_timestamp(), updated_at=clock_timestamp()
             WHERE run_id=$1 AND connector_id=$2 AND status='pending'`,
            [runId, this.connectorId, error.code, error.message]
          )
        : undefined
      if (submissionUncertain) {
        if (result?.rowCount !== 1)
          throw new Error(
            `Preparation claim was lost before failing review run ${runId}.`
          )
      } else {
        // Execution never ran, so it is skipped rather than failed. The reason stays on the
        // preparation row. Comparing the returned ids against the request makes a run that was
        // no longer `pending` surface as a lost transition instead of passing silently.
        const skipped = await skipPendingExecutions(client, this.connectorId, [
          runId
        ])
        if (skipped.length !== 1)
          throw new Error(
            `Execution for ${runId} was not pending when preparation failed.`
          )
      }
      // Publication is only "not applicable" once execution is conclusively skipped. An
      // uncertain submission may still be accepted, so its publication stays `pending`: ruling
      // it out early would require a later skipped -> pending reversion just to undo this.
      const skippedPublicationFrom = submissionUncertain
        ? null
        : await abandonInFlightPublication(client, this.connectorId, runId)
      // No notice on the uncertain path. The outcome there is unknown, not failed, so telling the
      // requester "this never started" would state a conclusion the replay may contradict — and a
      // posted comment cannot be taken back. The notice is created by `failSubmissionRecovery`
      // instead, in the transaction that turns that uncertainty into a real failure (the Execution
      // rejected the replay, or the replay budget ran out). Entering a failure stage below is
      // therefore limited to the branch that skipped execution outright.
      const preparationEventId = await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'preparation',
        fromStatus: 'preparing',
        toStatus: 'failed',
        reasonCode: error.code ?? null
      })
      if (!submissionUncertain) {
        await queueRunNotice(client, {
          runId,
          connectorId: this.connectorId,
          sourceEventId: preparationEventId,
          kind: 'failure',
          axis: 'preparation',
          reasonCode: error.code ?? null
        })
      }
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'execution',
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
      return { retry_scheduled: false }
    })
  }
}
