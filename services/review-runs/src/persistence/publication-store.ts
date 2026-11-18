// Owns publication lease renewal, completion, failure, and step progress.
// PublicationClaimStore selects work across execution and publication axes.
import { Pool, type PoolClient } from 'pg'
import type { Database } from '../database/database.js'

import { transaction } from '../database/transaction.js'
import {
  DeterministicReviewRunError,
  PUBLICATION_STEP_ERROR_CODES
} from '../errors.js'
import type { PublicationStatus, PublicationStepRecord } from '../shapes.js'
import { appendEvent, type AppendEventFields } from './review-run-events.js'
import { queueRunNotice, supersedeRunAttentionNotices } from './run-notices.js'

/** Step writes lock the publication row before reading or changing steps.
 *
 * withOwnedPublication checks the token under SELECT ... FOR UPDATE. This serializes step writes
 * with takeover and publication conclusion; UPDATE ... FROM alone would only read an ownership
 * snapshot and could allow a step write after another transaction released the publication.
 * Under the publication lock, step reads need no additional row locks.
 *
 * Step changes, derived axis changes, and their events commit in the same transaction. Events
 * use the stored previous status, including when a write accepts several source states.
 * To verify serialization, hold a publication update open on a second connection and assert
 * that a step write waits, then rejects a token released by that transaction.
 */

/** States whose current token may authorize step writes and lease renewal.
 * Uncertain and disconnected steps preserve the owner. Only disconnected blocks overall conclusion.
 */
const OWNED_PUBLICATION_STATUSES: readonly PublicationStatus[] = [
  'publishing',
  'uncertain',
  'disconnected'
]

/** A disconnected publication requires an operator decision before overall conclusion. */
const CONCLUDABLE_PUBLICATION_STATUSES: readonly PublicationStatus[] = [
  'publishing',
  'uncertain'
]

/** Claims spend the write budget, including attempts whose owner dies before reporting.
 * Exhaustion requires remote reconciliation before the step can be concluded.
 */
const MAX_PUBLICATION_STEP_ATTEMPTS = 3
/** Failed remote lookups that leave a step unresolved; operator resume resets this budget. */
const MAX_PUBLICATION_STEP_UNRESOLVED_RECOVERIES = 3

/** Whether the step has spent its write-attempt budget. */
function isStepExhausted(step: PublicationStepRecord) {
  return step.attempt_count >= MAX_PUBLICATION_STEP_ATTEMPTS
}

/** Project the strongest step state onto an owned publication: disconnected, uncertain,
 * otherwise publishing. Preserve the token so its owner can continue permitted step work.
 * Overall completion and failure are separate owner decisions.
 */
async function derivePublicationStatus(
  client: PoolClient,
  connectorId: string,
  runId: string
): Promise<void> {
  const result = await client.query<{
    from_status: string
    to_status: string
  }>(
    `
    WITH previous AS (
      SELECT run_id, status FROM publications
      WHERE run_id=$1 AND connector_id=$2
        AND status = ANY($3::text[])
      FOR UPDATE
    ),
    -- The axis reports the strongest step-level uncertainty. When no step is in either state, an
    -- axis that had been reporting one returns to publishing: the claim is still held, and the
    -- publisher carries on with the steps that remain. A step whose reconciliation ran out
    -- outranks an uncertain one, because that is what an operator queue has to surface.
    derived AS (
      SELECT p.run_id, p.status AS from_status,
             CASE
               WHEN EXISTS (SELECT 1 FROM publication_steps s
                            WHERE s.run_id=p.run_id AND s.connector_id=p.connector_id
                              AND s.status='disconnected') THEN 'disconnected'
               WHEN EXISTS (SELECT 1 FROM publication_steps s
                            WHERE s.run_id=p.run_id AND s.connector_id=p.connector_id
                              AND s.status='uncertain') THEN 'uncertain'
               WHEN p.status IN ('uncertain','disconnected') THEN 'publishing'
               ELSE p.status
             END AS to_status
      FROM publications p
      JOIN previous ON previous.run_id=p.run_id
    )
    UPDATE publications p
    SET status=derived.to_status, updated_at=clock_timestamp()
    FROM derived
    WHERE p.run_id=derived.run_id
      -- Only a real change is a transition, and only a transition is audited below.
      AND derived.from_status <> derived.to_status
    RETURNING derived.from_status, p.status AS to_status
  `,
    [runId, connectorId, OWNED_PUBLICATION_STATUSES]
  )
  const changed = result.rows[0]
  if (changed === undefined) return
  // The axis moved because of what a step did, and the audit log records every other transition
  // for the same reason: an axis state that changed with no event would make the timeline lie.
  const eventId = await appendEvent(client, {
    runId,
    connectorId,
    axis: 'publication',
    fromStatus: changed.from_status,
    toStatus: changed.to_status
  })
  if (changed.to_status === 'disconnected') {
    // A disconnected publication has stopped automatic recovery without establishing whether
    // its GitHub side effect happened. That is an attention condition, not a failure. Keeping it
    // in the same transaction as the transition means a crashed coordinator cannot park work
    // without also leaving the connector something durable to tell the operator.
    await queueRunNotice(client, {
      runId,
      connectorId,
      sourceEventId: eventId,
      kind: 'attention',
      axis: 'publication',
      reasonCode: 'PUBLICATION_RECOVERY_EXHAUSTED'
    })
  }
}

export class PublicationStore {
  /** The pool, guarded by the database's readiness check. */
  protected get pool(): Pool {
    return this.database.pool()
  }

  constructor(
    private readonly database: Database,
    private readonly connectorId: string,
    private readonly claimTimeoutMs: number
  ) {}

  heartbeatIntervalMs(): number {
    return Math.max(100, Math.min(30_000, Math.floor(this.claimTimeoutMs / 3)))
  }

  /** Renew the lease of a publication this owner holds.
   *
   * All three actively-owned states renew: `publishing` is normal progress, `uncertain` means the
   * owner is reconciling a step, and `disconnected` means automatic recovery stopped pending an
   * operator decision. Those step states preserve the current token. Lease expiry permits
   * takeover; renewal still succeeds until the token is replaced or released. */
  async renewClaim(runId: string, token: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE publications SET claimed_at=clock_timestamp(), updated_at=clock_timestamp()
       WHERE run_id=$1 AND connector_id=$2
           AND status = ANY($4::text[]) AND claim_token=$3`,
      [runId, this.connectorId, token, OWNED_PUBLICATION_STATUSES]
    )
    return result.rowCount === 1
  }

  /** Hand a publication back to automatic recovery, on an operator's decision.
   *
   * A publication is excluded from every claim while any step is `disconnected`
   * (`PublicationClaimStore.claim`/`claimNext`), which is correct for automation: the step's
   * remote outcome is unknown, so re-running it unsupervised could duplicate a side effect. It
   * also means nothing can ever retry the run, so an operator needs a way to hand the work back.
   *
   * The parked steps become fresh pending work, but this operation does not claim them. The
   * normal publication selector must perform the execution-axis checks and return the claim token
   * to the publisher that will actually use it. */
  async resumeDisconnectedOn(
    client: PoolClient,
    runId: string
  ): Promise<boolean> {
    const result = await client.query<{ from_status: string }>(
      `WITH previous AS (
         SELECT run_id, status FROM publications
         WHERE run_id=$1 AND connector_id=$2 AND status='disconnected'
         FOR UPDATE
       )
       UPDATE publications p
       SET status='pending', claim_token=NULL, claimed_at=NULL,
           updated_at=clock_timestamp()
       FROM previous
       WHERE p.run_id=previous.run_id
       RETURNING previous.status AS from_status`,
      [runId, this.connectorId]
    )
    const row = result.rows[0]
    if (row === undefined) return false
    // Refresh both budgets for disconnected steps; leave successful steps untouched.
    // Each operator resume is audited and grants another recovery cycle without a lifetime cap.
    const resumedSteps = await client.query<{ step_key: string }>(
      `UPDATE publication_steps
       SET status='pending', claimed_by=NULL, attempt_count=0, unresolved_recovery_count=0,
           updated_at=clock_timestamp()
       WHERE run_id=$1 AND connector_id=$2 AND status='disconnected'
       RETURNING step_key`,
      [runId, this.connectorId]
    )
    await appendEvent(client, {
      runId,
      connectorId: this.connectorId,
      axis: 'publication',
      fromStatus: row.from_status,
      toStatus: 'pending',
      reasonCode: 'PUBLICATION_RESUMED_BY_OPERATOR'
    })
    for (const step of resumedSteps.rows.toSorted((a, b) =>
      a.step_key.localeCompare(b.step_key)
    ))
      await this.appendStepEvent(client, runId, step.step_key, {
        fromStatus: 'disconnected',
        toStatus: 'pending',
        reasonCode: 'PUBLICATION_RESUMED_BY_OPERATOR'
      })
    await supersedeRunAttentionNotices(client, {
      runId,
      connectorId: this.connectorId,
      axis: 'publication'
    })
    return true
  }

  async complete(runId: string, token: string): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      const result = await client.query<{ from_status: string }>(
        `WITH previous AS (
           SELECT run_id, status FROM publications
           WHERE run_id=$1 AND connector_id=$2
             AND status = ANY($4::text[]) AND claim_token=$3
           FOR UPDATE
         )
         UPDATE publications p SET status='published', claim_token=NULL, claimed_at=NULL,
           finished_at=clock_timestamp(),
           failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
         FROM previous
         WHERE p.run_id=previous.run_id
           AND NOT EXISTS (SELECT 1 FROM publication_steps
             WHERE run_id=$1 AND connector_id=$2 AND status <> 'succeeded')
         RETURNING previous.status AS from_status`,
        [runId, this.connectorId, token, CONCLUDABLE_PUBLICATION_STATUSES]
      )
      const completed = result.rows[0]
      if (completed === undefined) return false
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'publication',
        fromStatus: completed.from_status,
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
      // Only CONCLUDABLE_PUBLICATION_STATUSES may conclude; a refused `disconnected` axis returns
      // false, which the caller already treats as nothing committed.
      const result = await client.query<{ from_status: string }>(
        `WITH previous AS (
           SELECT run_id, status FROM publications
           WHERE run_id=$1 AND connector_id=$2
             AND status = ANY($7::text[]) AND claim_token=$3
           FOR UPDATE
         )
         UPDATE publications p SET status=$4, claim_token=NULL, claimed_at=NULL, failure_code=$5,
           failure_message=$6,
           finished_at=CASE WHEN $4='failed' THEN clock_timestamp() ELSE NULL END,
           updated_at=clock_timestamp()
         FROM previous
         WHERE p.run_id=previous.run_id
         RETURNING previous.status AS from_status`,
        [
          runId,
          this.connectorId,
          token,
          toStatus,
          error.code ?? null,
          error.message,
          CONCLUDABLE_PUBLICATION_STATUSES
        ]
      )
      const failed = result.rows[0]
      if (failed === undefined) return false
      // A terminal publication failure ends the run, and this is the only place it is concluded,
      // so the requester is told about it here.
      const publicationEventId = await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'publication',
        fromStatus: failed.from_status,
        toStatus,
        reasonCode: error.code ?? null
      })
      if (toStatus === 'failed') {
        await queueRunNotice(client, {
          runId,
          connectorId: this.connectorId,
          sourceEventId: publicationEventId,
          kind: 'failure',
          axis: 'publication',
          reasonCode: error.code ?? null
        })
      }
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
      throw new DeterministicReviewRunError(
        `Publication ${runId} contains duplicate step keys.`,
        PUBLICATION_STEP_ERROR_CODES.set_duplicate
      )
    const owned = await this.withOwnedPublication(
      runId,
      token,
      false,
      async (client) => {
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
            // A step's creation is recorded like an axis' admission: `null -> pending`, so the log
            // shows every step that existed, including one that was never attempted.
            await this.appendStepEvent(client, runId, stepKey, {
              fromStatus: null,
              toStatus: 'pending'
            })
          }
          return true
        }
        // The stored set is the run's step set: it was fixed by the claim that created it, and every
        // later pass over this run - a takeover after an expired lease, an operator resume - is a
        // repeat of the same publication, not a fresh one. It must derive the same set: adding a
        // step would publish an unrecorded side effect, while omitting one would leave stored work
        // that this publisher never attempts and can never complete.
        const persisted = existing.rows.map((row) => row.step_key).sort()
        if (JSON.stringify(persisted) !== JSON.stringify(uniqueKeys)) {
          throw new DeterministicReviewRunError(
            `Publication step set changed for run ${runId}.`,
            PUBLICATION_STEP_ERROR_CODES.set_changed
          )
        }
        return true
      }
    )
    if (!owned)
      throw new Error(
        `Publication claim was lost before steps were initialized: ${runId}`
      )
  }
  async listPublicationSteps(runId: string): Promise<PublicationStepRecord[]> {
    return await this.listPublicationStepsWith(this.pool, runId)
  }

  /** The same read on a caller-provided client, so a locked publication can be inspected and
   * classified inside the transaction that holds the lock. */
  private async listPublicationStepsWith(
    client: Pick<PoolClient, 'query'>,
    runId: string
  ): Promise<PublicationStepRecord[]> {
    const result = await client.query<
      Omit<PublicationStepRecord, 'last_attempt_at'> & {
        last_attempt_at: Date | null
      }
    >(
      `
      SELECT step_key,status,attempt_count,last_attempt_at,unresolved_recovery_count,
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
      last_attempt_at: row.last_attempt_at?.toISOString() ?? null
    }))
  }
  /** Record one publication step transition on this connector's audit trail. */
  private async appendStepEvent(
    client: PoolClient,
    runId: string,
    stepKey: string,
    transition: Pick<
      AppendEventFields,
      'fromStatus' | 'toStatus' | 'reasonCode'
    >
  ): Promise<void> {
    await appendEvent(client, {
      axis: 'publication',
      runId,
      connectorId: this.connectorId,
      stepKey,
      ...transition
    })
  }

  /** Run a step write inside a transaction that first locks the publication this token owns.
   *
   * This is the only way to write `publication_steps` under a claim token: the lock is what makes
   * the step write and a concurrent publication conclusion serialise (see the module note), and
   * what lets step reads skip their own `FOR UPDATE`. Answers `notOwned` without running `write`
   * when the token no longer owns the publication. */
  private async withOwnedPublication<T>(
    runId: string,
    token: string,
    notOwned: T,
    write: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    return await transaction(this.pool, async (client) => {
      const owner = await client.query(
        `SELECT 1 FROM publications
         WHERE run_id=$1 AND connector_id=$2
           -- Ownership is the token. uncertain and disconnected describe what a step is doing,
           -- not who may act: the publisher holding the claim must still be able to settle the
           -- very step that put the axis in that state.
           AND status = ANY($4::text[]) AND claim_token=$3
         FOR UPDATE`,
        [runId, this.connectorId, token, OWNED_PUBLICATION_STATUSES]
      )
      if (owner.rowCount !== 1) return notOwned
      return await write(client)
    })
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
    return await this.withOwnedPublication(
      runId,
      token,
      false,
      async (client) => {
        // `previous` reads the row before this UPDATE, so the event names the state the claim left.
        const result = await client.query<{ from_status: string }>(
          `
        UPDATE publication_steps s
        SET status='running', claimed_by=$3, attempt_count=s.attempt_count+1,
            last_attempt_at=clock_timestamp(), updated_at=clock_timestamp()
        -- Step reads need no FOR UPDATE under the publication lock; see the module note.
        FROM (SELECT status FROM publication_steps
              WHERE run_id=$1 AND connector_id=$2 AND step_key=$4) previous
        WHERE s.run_id=$1 AND s.connector_id=$2 AND s.step_key=$4
          -- Every claimable state shares one condition: the budget is checked on the effective
          -- attempt number, which is the stored count plus the claim about to happen. Testing
          -- the current count would let a step reach MAX+1 attempts before being refused, and
          -- treating "pending" or a crashed "running" step as free would exempt exactly the
          -- attempts that never reported back.
          AND s.attempt_count + 1 <= $5
          AND (
            s.status='pending'
            -- A step left running belongs to an owner that may have died mid-effect. Only a
            -- different token may take it over: the same owner claiming its own running step
            -- would start a second attempt for one side effect, which is precisely what the
            -- attempt count is supposed to make visible rather than corrupt.
            OR (s.status='running' AND s.claimed_by IS DISTINCT FROM $3::uuid)
            OR s.status='failed'
          )
        RETURNING previous.status AS from_status
      `,
          [
            runId,
            this.connectorId,
            token,
            stepKey,
            MAX_PUBLICATION_STEP_ATTEMPTS
          ]
        )
        const claimed = result.rows[0]
        if (claimed === undefined) return false
        await this.appendStepEvent(client, runId, stepKey, {
          fromStatus: claimed.from_status,
          toStatus: 'running'
        })
        return true
      }
    )
  }
  async requirePublicationStepClaim(
    runId: string,
    token: string,
    stepKey: string
  ): Promise<void> {
    if (await this.claimPublicationStep(runId, token, stepKey)) return

    // A token that no longer owns the publication gets `not_claimable` below: there is nothing
    // left for it to reconcile.
    const exhausted = await this.withOwnedPublication(
      runId,
      token,
      false,
      async (client) => {
        const steps = await this.listPublicationStepsWith(client, runId)
        const current = steps.find((item) => item.step_key === stepKey)
        const needsReconciliation =
          current !== undefined &&
          isStepExhausted(current) &&
          // A step that already reached a terminal outcome is not re-tested: only the live states
          // can still be waiting for the reconciliation below.
          (current.status === 'failed' ||
            current.status === 'running' ||
            current.status === 'uncertain')
        if (needsReconciliation && current.status !== 'uncertain') {
          const moved = await client.query(
            `UPDATE publication_steps SET status='uncertain', claimed_by=NULL,
             updated_at=clock_timestamp()
           WHERE run_id=$1 AND connector_id=$2 AND step_key=$3
             AND status IN ('failed','running') AND attempt_count >= $4`,
            [runId, this.connectorId, stepKey, MAX_PUBLICATION_STEP_ATTEMPTS]
          )
          // `current` was read under the publication lock, so it is the status this UPDATE left.
          if (moved.rowCount === 1)
            await this.appendStepEvent(client, runId, stepKey, {
              fromStatus: current.status,
              toStatus: 'uncertain'
            })
        }
        await derivePublicationStatus(client, this.connectorId, runId)
        return needsReconciliation
      }
    )
    // A `disconnected` step never reaches here: an operator resume returns it to `pending`, and
    // every other route into `disconnected` parks the publication itself, which excludes it from
    // every claim. So the only reason a step is refused below is a spent attempt budget, and
    // reconciliation is always what is offered.
    if (exhausted) {
      // Exhaustion alone is NOT a conclusion. A `running` step means an owner started the side
      // effect and may have completed it on the remote system before dying, and a `failed` step's
      // last attempt may also have taken effect before its response was lost. Both are invisible
      // here: Review Runs cannot see GitHub, so it must not decide that nothing was published.
      //
      // The answer is to hand the step back for a read-only reconciliation instead of terminating
      // it. The connector knows what its own side effect looks like (a branch, a review marker, a
      // comment marker), so it can ask the remote whether the effect exists; only that answer may
      // end the step as `terminal_failed`, and `settleExhaustedPublicationStep` is the single write
      // path for it. `retry_exhausted` therefore no longer means "the step failed" — it means "no
      // attempt is left, reconcile before concluding".
      throw new DeterministicReviewRunError(
        `Publication step ${stepKey} has no attempts left; reconcile the remote effect before concluding it.`,
        PUBLICATION_STEP_ERROR_CODES.retry_exhausted
      )
    }
    throw new DeterministicReviewRunError(
      `Publication step is not claimable: ${stepKey}`,
      PUBLICATION_STEP_ERROR_CODES.not_claimable
    )
  }
  /** Conclude an exhausted step after the connector has checked the remote system.
   *
   * `published` records the side effect the connector found: the step becomes `succeeded` with
   * the same remote reference a live completion would have written, so the publication can still
   * finish. `absent` records that the connector looked and found nothing; only then does the step
   * become `terminal_failed`.
   *
   * Both answers are writes because both end the step, and both are fenced the same way: the
   * caller must still own the publication and the step must still be exhausted and un-terminated.
   * Replacing the publication token on takeover prevents the previous owner from concluding
   * a step the new owner is reconciling; lease expiry alone does not invalidate the token. */
  async settleExhaustedPublicationStep(
    runId: string,
    token: string,
    stepKey: string,
    outcome:
      | { found: true; remote: { id?: string | null; url?: string | null } }
      | { found: false }
  ): Promise<boolean> {
    return await this.withOwnedPublication(
      runId,
      token,
      false,
      async (client) => {
        // Both answers share one guard and one parameter prefix: $1-$3 name the step and $4 is the
        // attempt ceiling, so the two statements cannot drift apart on what "still exhausted" means.
        const exhaustedStep = `WHERE run_id=$1 AND connector_id=$2 AND step_key=$3
              AND status='uncertain' AND attempt_count>=$4`
        const stepParams = [
          runId,
          this.connectorId,
          stepKey,
          MAX_PUBLICATION_STEP_ATTEMPTS
        ]
        const result = outcome.found
          ? await client.query(
              `
            UPDATE publication_steps
            SET status='succeeded', claimed_by=NULL, remote_object_id=$5,
                remote_object_url=$6, failure_code=NULL, failure_message=NULL,
                updated_at=clock_timestamp()
            ${exhaustedStep}
          `,
              [
                ...stepParams,
                outcome.remote.id ?? null,
                outcome.remote.url ?? null
              ]
            )
          : await client.query(
              `
            UPDATE publication_steps
            SET status='terminal_failed', claimed_by=NULL, updated_at=clock_timestamp()
            ${exhaustedStep}
          `,
              stepParams
            )
        if (result.rowCount !== 1) return false
        await this.appendStepEvent(client, runId, stepKey, {
          fromStatus: 'uncertain',
          toStatus: outcome.found ? 'succeeded' : 'terminal_failed'
        })
        // Settling is what clears a step-level uncertainty, so the axis has to follow it back.
        await derivePublicationStatus(client, this.connectorId, runId)
        return true
      }
    )
  }
  async completePublicationStep(
    runId: string,
    token: string,
    stepKey: string,
    remote: { id?: string | null; url?: string | null } = {}
  ): Promise<boolean> {
    // Every step commit checks the current publication token, so a previous owner cannot
    // record remote data after takeover or release.
    return await this.withOwnedPublication(
      runId,
      token,
      false,
      async (client) => {
        const result = await client.query(
          `
        UPDATE publication_steps s
        SET status='succeeded', claimed_by=NULL,
            remote_object_id=$4, remote_object_url=$5,
            failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
        WHERE s.run_id=$1 AND s.connector_id=$2 AND s.step_key=$3 AND s.status='running'
      `,
          [
            runId,
            this.connectorId,
            stepKey,
            remote.id ?? null,
            remote.url ?? null
          ]
        )
        if (result.rowCount !== 1) return false
        await this.appendStepEvent(client, runId, stepKey, {
          fromStatus: 'running',
          toStatus: 'succeeded'
        })
        return true
      }
    )
  }
  async failPublicationStep(
    runId: string,
    token: string,
    stepKey: string,
    error: { code?: string | null; message: string },
    options: { retry?: boolean; expectedUnresolvedRecoveryCount?: number } = {}
  ): Promise<boolean> {
    const terminal = options.retry === false
    const expected = options.expectedUnresolvedRecoveryCount ?? null
    return await this.withOwnedPublication(
      runId,
      token,
      false,
      async (client) => {
        // A reconciliation failure names the count it was reported against, the way an activity
        // failure carries its attempt number. If the count has already moved past it, this exact
        // failure was recorded by an earlier call whose response was lost: answer that it is
        // recorded instead of spending the budget again. The step may have parked since, so this is
        // decided before the status guard below, which would refuse a `disconnected` step.
        if (expected !== null) {
          const current = await client.query<{
            unresolved_recovery_count: number
          }>(
            `SELECT unresolved_recovery_count FROM publication_steps
           WHERE run_id=$1 AND connector_id=$2 AND step_key=$3`,
            [runId, this.connectorId, stepKey]
          )
          const stored = current.rows[0]?.unresolved_recovery_count
          if (stored !== undefined && stored > expected) return true
        }
        // Placeholders are ordered by type, not by the call's argument list: $1/$2 are the
        // identity, $3/$4 the connector-supplied strings, $5 the status, $6 the step, $7-$9 the
        // retry flag, the recovery budget, and the count this failure was reported against. Swapping
        // $3 and $4 would silently store the message as the code (both are text), which no
        // status-only assertion would catch.
        const result = await client.query<{
          from_status: string
          to_status: string
        }>(
          `
        UPDATE publication_steps s
        SET status=CASE
              WHEN s.status='uncertain' AND $7::boolean
                AND s.unresolved_recovery_count+1 >= $8 THEN 'disconnected'
              WHEN s.status='uncertain' AND $7::boolean THEN 'uncertain'
              ELSE $5
            END,
            claimed_by=NULL,
            unresolved_recovery_count=CASE
              WHEN s.status='uncertain' AND $7::boolean
                THEN s.unresolved_recovery_count+1
              ELSE s.unresolved_recovery_count
            END,
            failure_code=$3, failure_message=$4, updated_at=clock_timestamp()
        -- Step reads need no FOR UPDATE under the publication lock; see the module note.
        FROM (SELECT status FROM publication_steps
              WHERE run_id=$1 AND connector_id=$2 AND step_key=$6) previous
        WHERE s.run_id=$1 AND s.connector_id=$2 AND s.step_key=$6
          AND s.status IN ('running','uncertain')
          AND ($9::integer IS NULL OR s.unresolved_recovery_count = $9)
        RETURNING previous.status AS from_status, s.status AS to_status
      `,
          [
            runId,
            this.connectorId,
            error.code ?? null,
            error.message,
            terminal ? 'terminal_failed' : 'failed',
            stepKey,
            options.retry === true,
            MAX_PUBLICATION_STEP_UNRESOLVED_RECOVERIES,
            expected
          ]
        )
        const moved = result.rows[0]
        if (moved === undefined) return false
        await this.appendStepEvent(client, runId, stepKey, {
          fromStatus: moved.from_status,
          toStatus: moved.to_status,
          reasonCode: error.code ?? null
        })
        // A reconciliation that could not reach an answer moves the step to `disconnected`; the
        // axis reports that so the run surfaces in the operator queue instead of looking active.
        // A terminal step failure ends only that step. Whether the publication goes on is the
        // connector's decision: it may publish its other steps and then conclude through `complete`
        // (refused while any step has not succeeded) or `fail`. Concluding the publication here
        // would take the claim away from steps the connector still means to publish.
        await derivePublicationStatus(client, this.connectorId, runId)
        return true
      }
    )
  }
}
