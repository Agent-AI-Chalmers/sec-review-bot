// Owns the single-axis publication writes: lease renewal, completion, failure, and per-step
// progress. These only touch `publications` / `publication_steps`, so `ReviewRunStore` forwards
// to them unchanged.
//
// Selecting publishable work is deliberately NOT here. It requires the execution axis
// (`executions.status='succeeded'` and a non-null workflow_result) and returns a full
// cross-axis record, so it lives in `ReviewRunStore` as cross-axis orchestration rather than as
// a single-axis write. Do not reintroduce a publication-only selection here: a version that
// duplicated the SQL without a caller is what this comment replaces.
//
// Resuming a disconnected publication is still a single-axis write: it returns the row to
// `pending`, where the normal cross-axis selector can claim it after checking execution.
import { Pool, type PoolClient } from 'pg'

import { transaction } from '../database/transaction.js'
import {
  DeterministicReviewRunError,
  PUBLICATION_STEP_ERROR_CODES
} from '../errors.js'
import type { PublicationStepRecord } from '../shapes.js'
import { appendEvent } from './review-run-events.js'
import { queueRunNotice } from './run-notices.js'

/**
 * Why every `publication_steps` write takes the publication row lock FIRST.
 *
 * PostgreSQL keeps the legacy "one statement validates its own precondition" habit dangerous
 * here. A statement like
 *
 *     UPDATE publication_steps s SET ... FROM publications p
 *     WHERE p.run_id = s.run_id AND p.status = 'publishing' AND p.claim_token = $token
 *
 * looks like it checks the publication before writing the step, but `publications` is only a
 * snapshot read: no row lock is taken on it (an `EXPLAIN`/`pg_locks` inspection shows just an
 * ACCESS SHARE relation lock and no tuple lock on `publications`). So a concurrent transaction
 * that converges the publication to `skipped` — an execution failure, a rejected submission
 * replay, or an operator abandon — can commit between this statement's snapshot and its write,
 * and the step is still recorded on a publication that no longer publishes anything.
 *
 * The result of that race is a permanent orphan: `publications.status='skipped'` next to a
 * `publication_steps` row that is `running` (or `succeeded`) with a claim token whose owner is
 * gone. Nothing sweeps such rows, because every repair path starts from a publication that is
 * still `publishing`, so the contradiction stays visible to operators and misleads them into
 * looking for a publisher that does not exist. It also invalidates the reasoning the claim path
 * depends on (`attempt_count > 1` means "a previous owner may have already run this side
 * effect"), because the step is neither really running nor definitely abandoned.
 *
 * The fix is to lock the publication row and re-read it inside the same transaction
 * (`SELECT ... FOR UPDATE`) before touching the step. That serialises the two writers: either
 * the step write commits first, or it observes the conclusion and refuses. The shared
 * `lockPublicationOwnership` helper does this so the three write paths cannot drift apart: a
 * step write that skipped the lock would look correct on its own while disagreeing with the
 * other two.
 *
 * Note on discovery: this is not reproducible by adding concurrency pressure. Interleavings are
 * only observable when one writer's UPDATE is deliberately left uncommitted while the other
 * proceeds, so a stress test tends to report "no deadlock, no errors" and prove nothing. The
 * failure is a lost update, not a lock wait: the two writers never block each other today, they
 * merely disagree. Verify a change here by forcing the interleaving (hold the publication
 * UPDATE open in a second session and assert the step write waits), not by raising the load.
 */

/** How many times one side effect may be attempted before the step is given up on.
 *
 * The budget is spent by attempts, not by recorded failures, so a publisher that dies mid-effect
 * consumes one too. That is deliberate: an attempt whose outcome is unknown is not free, and a
 * crash loop has to end the same way a failure loop does. It also keeps the ceiling equal to the
 * only number the system can observe without trusting a counter to agree with the rows it
 * summarises. The other axes bound work the same way and for the same reason, each with its own
 * number (`MAX_PREPARATION_ATTEMPTS` here, `MAX_SUBMISSION_RECOVERY_ATTEMPTS` for replays), so
 * changing one is a local decision about that axis' external traffic rather than a shared policy. */
const MAX_PUBLICATION_STEP_ATTEMPTS = 3
const MAX_PUBLICATION_STEP_RECOVERY_ATTEMPTS = 3

/** Whether this step has used up its attempts and is waiting on a reconciliation decision.
 *
 * `failed` and `running` are the two states an exhausted step can be in: `failed` means the last
 * attempt reported a failure (which may still have taken effect remotely), and `running` means an
 * owner started one and never reported at all. `pending` cannot be exhausted because it has not
 * spent an attempt. */
function isStepExhausted(step: PublicationStepRecord): boolean {
  return step.attempt_count >= MAX_PUBLICATION_STEP_ATTEMPTS
}

/** Re-derive the publication axis from the state of its steps.
 *
 * The axis carries no independent opinion about uncertainty: a step is what interacts with the
 * remote system, so only a step can be uncertain or disconnected. The axis reflects the strongest
 * such state so an operator queue can find the run without walking every step, and it never
 * overrides a step: `uncertain` and `disconnected` describe where reconciliation got stuck, and
 * `published`/`failed` remain the axis' own conclusion.
 *
 * `publishing` is kept whenever a live publisher exists, so this cannot pull a claimed
 * publication out from under its owner.
 */
async function derivePublicationStatus(
  client: PoolClient,
  connectorId: string,
  runId: string
): Promise<void> {
  // The target status is computed once, in the `derived` CTE, rather than in both SET and WHERE.
  // The two used to spell out the same CASE twice; a later edit to one copy would then produce a
  // write whose guard disagreed with its assignment - a silent no-op in one direction, or an
  // event logged for a state the row never held in the other.
  const result = await client.query<{
    from_status: string
    to_status: string
  }>(
    `
    WITH previous AS (
      SELECT run_id, status FROM publications
      WHERE run_id=$1 AND connector_id=$2
        AND status IN ('publishing','uncertain','disconnected')
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
    [runId, connectorId]
  )
  const changed = result.rows[0]
  if (changed === undefined) return
  // The axis moved because of what a step did, and the audit log records every other transition
  // for the same reason: an axis state that changed with no event would make the timeline lie.
  await appendEvent(client, {
    runId,
    connectorId,
    axis: 'publication',
    fromStatus: changed.from_status,
    toStatus: changed.to_status
  })
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

  /** Renew the lease of a publication this owner holds.
   *
   * All three actively-owned states renew: `publishing` is normal progress, `uncertain` means the
   * owner is reconciling a step, and `disconnected` means an operator handed it back and its
   * steps are being reconciled again. Ownership is the token; the status only says what the steps
   * are doing. */
  async renewClaim(runId: string, token: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE publications SET claimed_at=clock_timestamp(), updated_at=clock_timestamp()
       WHERE run_id=$1 AND connector_id=$2
           AND status IN ('publishing','uncertain','disconnected') AND claim_token=$3`,
      [runId, this.connectorId, token]
    )
    return result.rowCount === 1
  }

  /** Hand a publication back to automatic recovery, on an operator's decision.
   *
   * A publication is excluded from every claim while any step is `disconnected`
   * (`claimPublication`/`claimNextPublication`), which is correct for automation: the step's
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
    {
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
      // The resume returns the attempt budget, which is what makes it "published again" rather
      // than "keep publishing": a spent budget refuses the write, so without this the connector
      // could only ever reconcile, and would conclude a step it found absent as failed.
      //
      // There is deliberately no cap on how often this can be granted. The caller is an operator
      // holding the admin token, and that authority is theirs: capping it here would replace their
      // judgment with a constant, while still leaving the same power available to whoever can
      // change the constant. What the system owes them instead is a record - every resume appends
      // its own event - so the decision is visible after the fact rather than blocked in advance.
      // Parked steps become attemptable and reconcilable again: the status returns to `pending`
      // so a claim can start the side effect, and both budgets are refreshed. Steps that already
      // succeeded are untouched - the run continues from where it stopped, it does not start over.
      await client.query(
        `UPDATE publication_steps
         SET status='pending', claimed_by=NULL, attempt_count=0, recovery_attempt_count=0,
             updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='disconnected'`,
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
      return true
    }
  }

  async complete(runId: string, token: string): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE publications SET status='published', claim_token=NULL,
           finished_at=clock_timestamp(),
           failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2
           AND status IN ('publishing','uncertain','disconnected') AND claim_token=$3
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
         WHERE run_id=$1 AND connector_id=$2
           AND status IN ('publishing','uncertain','disconnected') AND claim_token=$3`,
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
      const publicationEventId = await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'publication',
        fromStatus: 'publishing',
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
    await transaction(this.pool, async (client) => {
      const owner = await client.query(
        `
        SELECT 1 FROM publications
        WHERE run_id=$1 AND connector_id=$2
          AND status IN ('publishing','uncertain','disconnected') AND claim_token=$3
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
    })
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
        last_attempt_at: Date | string | null
      }
    >(
      `
      SELECT step_key,status,attempt_count,last_attempt_at,
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
  /** Lock the publication that owns this claim token, or answer false.
   *
   * Callers must hold the returned lock before writing `publication_steps`; see the module-level
   * note on why a single `UPDATE ... FROM publications` is not sufficient. Kept in one place so
   * the claim, complete, and fail paths cannot diverge in the order they take these locks. */
  private async lockPublicationOwnership(
    client: PoolClient,
    runId: string,
    token: string
  ): Promise<boolean> {
    const owner = await client.query(
      `SELECT 1 FROM publications
       WHERE run_id=$1 AND connector_id=$2
         -- Ownership is the token. uncertain and disconnected describe what a step is doing, not
         -- who may act: the publisher holding the claim must still be able to settle the very
         -- step that put the axis in that state.
         AND status IN ('publishing','uncertain','disconnected') AND claim_token=$3
       FOR UPDATE`,
      [runId, this.connectorId, token]
    )
    return owner.rowCount === 1
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
    return await transaction(this.pool, async (client) => {
      // Lock first; see the module note on why the step UPDATE alone is not a precondition check.
      if (!(await this.lockPublicationOwnership(client, runId, token)))
        return false
      const result = await client.query(
        `
        UPDATE publication_steps s
        SET status='running', claimed_by=$3, attempt_count=s.attempt_count+1,
            last_attempt_at=clock_timestamp(), updated_at=clock_timestamp()
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
      `,
        [runId, this.connectorId, token, stepKey, MAX_PUBLICATION_STEP_ATTEMPTS]
      )
      return result.rowCount === 1
    })
  }
  async requirePublicationStepClaim(
    runId: string,
    token: string,
    stepKey: string
  ): Promise<void> {
    if (await this.claimPublicationStep(runId, token, stepKey)) return

    const exhausted = await transaction(this.pool, async (client) => {
      const owned = await this.lockPublicationOwnership(client, runId, token)
      const steps = await this.listPublicationStepsWith(client, runId)
      const current = steps.find((item) => item.step_key === stepKey)
      const needsReconciliation =
        owned &&
        current !== undefined &&
        isStepExhausted(current) &&
        // A step that already reached a terminal outcome is not re-tested: only the live states
        // can still be waiting for the reconciliation below.
        (current.status === 'failed' ||
          current.status === 'running' ||
          current.status === 'uncertain')
      if (needsReconciliation && current.status !== 'uncertain') {
        await client.query(
          `UPDATE publication_steps SET status='uncertain', claimed_by=NULL,
             updated_at=clock_timestamp()
           WHERE run_id=$1 AND connector_id=$2 AND step_key=$3
             AND status IN ('failed','running') AND attempt_count >= $4`,
          [runId, this.connectorId, stepKey, MAX_PUBLICATION_STEP_ATTEMPTS]
        )
      }
      await derivePublicationStatus(client, this.connectorId, runId)
      return needsReconciliation
    })
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
   * That is what stops a publisher whose claim expired from concluding a step another owner is
   * already reconciling. */
  async settleExhaustedPublicationStep(
    runId: string,
    token: string,
    stepKey: string,
    outcome:
      | { found: true; remote: { id?: string | null; url?: string | null } }
      | { found: false }
  ): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      if (!(await this.lockPublicationOwnership(client, runId, token)))
        return false
      const result = outcome.found
        ? await client.query(
            `
            UPDATE publication_steps
            SET status='succeeded', claimed_by=NULL, remote_object_id=$4,
                remote_object_url=$5, failure_code=NULL, failure_message=NULL,
                updated_at=clock_timestamp()
            WHERE run_id=$1 AND connector_id=$2 AND step_key=$3
              AND status='uncertain' AND attempt_count>=$6
          `,
            [
              runId,
              this.connectorId,
              stepKey,
              outcome.remote.id ?? null,
              outcome.remote.url ?? null,
              MAX_PUBLICATION_STEP_ATTEMPTS
            ]
          )
        : await client.query(
            `
            UPDATE publication_steps
            SET status='terminal_failed', claimed_by=NULL, updated_at=clock_timestamp()
            WHERE run_id=$1 AND connector_id=$2 AND step_key=$3
              AND status='uncertain' AND attempt_count>=$4
          `,
            [runId, this.connectorId, stepKey, MAX_PUBLICATION_STEP_ATTEMPTS]
          )
      if (result.rowCount !== 1) return false
      // Settling is what clears a step-level uncertainty, so the axis has to follow it back.
      await derivePublicationStatus(client, this.connectorId, runId)
      return true
    })
  }
  async completePublicationStep(
    runId: string,
    token: string,
    stepKey: string,
    remote: { id?: string | null; url?: string | null } = {}
  ): Promise<boolean> {
    // A publication token fences every step commit, not only the final run state, so a timed-out
    // worker cannot record stale remote data.
    return await transaction(this.pool, async (client) => {
      // Lock first; see the module note on why the step UPDATE alone is not a precondition check.
      if (!(await this.lockPublicationOwnership(client, runId, token)))
        return false
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
      return result.rowCount === 1
    })
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
      // Lock first; see the module note on why the step UPDATE alone is not a precondition check.
      if (!(await this.lockPublicationOwnership(client, runId, token)))
        return false
      // Placeholders are ordered by type, not by the call's argument list: $1/$2 are the
      // identity, $3/$4 the connector-supplied strings, $5 the status, $6 the step. Swapping
      // $3 and $4 would silently store the message as the code (both are text), which no
      // status-only assertion would catch.
      const result = await client.query(
        `
        UPDATE publication_steps s
        SET status=CASE
              WHEN s.status='uncertain' AND $7::boolean
                AND s.recovery_attempt_count+1 >= $8 THEN 'disconnected'
              WHEN s.status='uncertain' AND $7::boolean THEN 'uncertain'
              ELSE $5
            END,
            claimed_by=NULL,
            recovery_attempt_count=CASE
              WHEN s.status='uncertain' AND $7::boolean
                THEN s.recovery_attempt_count+1
              ELSE s.recovery_attempt_count
            END,
            failure_code=$3, failure_message=$4, updated_at=clock_timestamp()
        WHERE s.run_id=$1 AND s.connector_id=$2 AND s.step_key=$6
          AND s.status IN ('running','uncertain')
      `,
        [
          runId,
          this.connectorId,
          error.code ?? null,
          error.message,
          terminal ? 'terminal_failed' : 'failed',
          stepKey,
          options.retry === true,
          MAX_PUBLICATION_STEP_RECOVERY_ATTEMPTS
        ]
      )
      if (result.rowCount !== 1) return false
      // A reconciliation that could not reach an answer moves the step to `disconnected`; the
      // axis reports that so the run surfaces in the operator queue instead of looking active.
      await derivePublicationStatus(client, this.connectorId, runId)
      if (!terminal) return true
      // The step update above already moved the axis by re-deriving it from the steps, so the
      // terminal failure has to name the state it is actually leaving: `uncertain` when this step
      // was the uncertain one, `disconnected` when another step parked the axis. Recording a
      // hardcoded `publishing` would put an edge in the log the snapshot never held.
      const publication = await client.query<{ from_status: string }>(
        `WITH previous AS (
           SELECT run_id, status FROM publications
           WHERE run_id=$1 AND connector_id=$2
             AND status IN ('publishing','uncertain','disconnected') AND claim_token=$5
           FOR UPDATE
         )
         UPDATE publications p
         SET status='failed', claim_token=NULL, claimed_at=NULL,
             failure_code=$3, failure_message=$4, finished_at=clock_timestamp(),
             updated_at=clock_timestamp()
         FROM previous
         WHERE p.run_id=previous.run_id
         RETURNING previous.status AS from_status`,
        [runId, this.connectorId, error.code ?? null, error.message, token]
      )
      const failedFrom = publication.rows[0]?.from_status
      if (failedFrom === undefined)
        throw new Error(
          `Publication ${runId} changed while its terminal step failed.`
        )
      const eventId = await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'publication',
        fromStatus: failedFrom,
        toStatus: 'failed',
        reasonCode: error.code ?? null
      })
      await queueRunNotice(client, {
        runId,
        connectorId: this.connectorId,
        sourceEventId: eventId,
        kind: 'failure',
        axis: 'publication',
        reasonCode: error.code ?? null
      })
      return true
    })
  }
}
