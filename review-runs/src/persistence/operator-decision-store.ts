import type { Pool } from 'pg'

import { ExecutionStore } from './execution-store.js'
import { PublicationStore } from './publication-store.js'
import { abandonInFlightPublication } from './publication-abandon.js'
import { appendEvent } from './review-run-events.js'
import { findRunRecord } from './run-record-projection.js'
import { queueRunNotice } from './run-notices.js'
import { transaction } from '../database/transaction.js'
import type { ReviewRunRecord } from '../shapes.js'

export class OperatorDecisionStore {
  constructor(
    private readonly pool: Pool,
    private readonly connectorId: string,
    private readonly publications: PublicationStore,
    private readonly executions: ExecutionStore
  ) {}

  /** Abandon a blocked run at an operator's explicit request.
   *
   * This is not a repair and does not try to make the run publishable: it concludes the axes
   * that are still open, so the run stops holding work no coordinator can conclude. The
   * execution axis is deliberately left exactly as it is - a `succeeded` result and its
   * `workflow_result` stay on the row - because abandoning says "this result will not be
   * delivered", not "this result never happened". Nothing is deleted: the run, its events, and
   * its ingress identity all remain, so a replay of the same webhook still resolves to this run
   * instead of starting a new one.
   *
   * Only a preparation parked by a contradiction (`disconnected`) is eligible. A run parked on
   * execution or publication is ended with `giveUpDisconnectedRun` instead. That restriction is
   * what keeps this from becoming a general state-jumping endpoint: it can only finish a
   * transition coordination already proved impossible.
   *
   * `reason` is required and recorded on every event, so an abandonment always names why. */
  async abandonBlockedPreparation(
    runId: string,
    reason: string
  ): Promise<ReviewRunRecord> {
    if (reason.trim() === '')
      throw Object.assign(new Error('An abandonment reason is required.'), {
        statusCode: 400
      })
    return await transaction(this.pool, async (client) => {
      // Claim the decision: only one caller may abandon a given disconnected row, and its state
      // doubles as the "still needs a decision" flag. The reason it was parked is read here so
      // the decision is recorded under its own name: this route only exists for the
      // contradiction `EXECUTION_ALREADY_ADVANCED`, and every reason the audit log writes must
      // be one the contract declares for that edge.
      const blocked = await client.query<{
        attempt_count: number
        disconnect_reason: string | null
      }>(
        `SELECT attempt_count, disconnect_reason FROM preparations
         WHERE run_id=$1 AND connector_id=$2
           AND status='disconnected'
         FOR UPDATE`,
        [runId, this.connectorId]
      )
      if (blocked.rowCount !== 1)
        throw Object.assign(
          new Error(`Review run ${runId} is not a disconnected preparation.`),
          { statusCode: 409 }
        )

      // The stored reason is the one the contract declares for this edge, and the CHECK that
      // pairs `disconnected` with a reason guarantees it is present for a selected row.
      const abandonCode =
        blocked.rows[0]?.disconnect_reason ?? 'EXECUTION_ALREADY_ADVANCED'
      const failed = await client.query(
        `UPDATE preparations
         SET status='failed', claim_token=NULL, claimed_at=NULL,
             failure_code=$4,
             failure_message=$3,
             last_failure_code=$4,
             last_failure_message=$3,
             finished_at=clock_timestamp(),
             disconnect_reason=NULL,
             updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='disconnected'`,
        [runId, this.connectorId, reason, abandonCode]
      )
      if (failed.rowCount !== 1)
        // The row was selected `FOR UPDATE` above, so nothing else can change it while this
        // transaction runs: reaching here means the stored row disagrees with itself, never a
        // lost race. That is a caller-visible fact about the run rather than a server fault, so
        // it answers 409 like every other "this run is not in a state this operation may act on".
        throw Object.assign(
          new Error(
            `Preparation ${runId} is disconnected but its state changed; nothing was written.`
          ),
          { statusCode: 409 }
        )
      const preparationEventId = await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'preparation',
        fromStatus: 'disconnected',
        toStatus: 'failed',
        reasonCode: abandonCode
      })
      await queueRunNotice(client, {
        runId,
        connectorId: this.connectorId,
        sourceEventId: preparationEventId,
        kind: 'failure',
        axis: 'preparation',
        reasonCode: abandonCode
      })
      // The execution axis must not outlive the run's decision. A blocked run is blocked
      // precisely because execution already advanced, so it may still be `queued` or `running`
      // and would otherwise be driven to `succeeded` later with nowhere for that result to go -
      // an "execution succeeded, publication skipped" pair that reads as a normal outcome while
      // the notice says the run failed. An execution that already succeeded is left alone: that
      // is a real result and the evidence behind the blocked decision. One that is still moving
      // cannot deliver anything now, so it ends here; `skipped` is wrong for it because it did
      // run.
      const stoppedExecution = await client.query<{ from_status: string }>(
        `WITH previous AS (
           SELECT run_id, status FROM executions
           WHERE run_id=$1 AND connector_id=$2
             AND status IN ('queued','running','uncertain')
           FOR UPDATE
         )
         UPDATE executions e
         SET status='failed', claim_token=NULL, claimed_at=NULL,
             failure_code=$4,
             failure_message=$3,
             finished_at=COALESCE(e.finished_at, clock_timestamp()),
             observed_at=clock_timestamp(), updated_at=clock_timestamp()
         FROM previous
         WHERE e.run_id=previous.run_id
         RETURNING previous.status AS from_status`,
        [runId, this.connectorId, reason, abandonCode]
      )
      if (stoppedExecution.rows[0] !== undefined) {
        await appendEvent(client, {
          runId,
          connectorId: this.connectorId,
          axis: 'execution',
          fromStatus: stoppedExecution.rows[0].from_status,
          toStatus: 'failed',
          reasonCode: abandonCode
        })
      }
      // Any publication still waiting is not applicable now that the run will not deliver a
      // result. The helper reports what it actually moved, so the event names the real origin.
      const publicationFrom = await abandonInFlightPublication(
        client,
        this.connectorId,
        runId
      )
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
      const record = await findRunRecord(client, this.connectorId, runId)
      if (record === null)
        throw new Error(`Review run ${runId} disappeared during abandonment.`)
      return record
    })
  }
  /** Resume whichever axis can actually be resumed; see the per-axis methods.
   *
   * Not every disconnected run is resumable, and the difference is not cosmetic:
   *
   * - A disconnected execution replays its already-persisted input under the same run_id, so
   *   resuming it is safe and is the only automatic way to learn the outcome.
   * - A disconnected publication returns to the normal claim queue. Its disconnected steps
   *   receive fresh attempt and reconciliation budgets; succeeded steps remain complete.
   * - A disconnected preparation is resumable only while execution is still `pending`. That is
   *   the claim condition `claimNext` enforces: if execution moved on, a resumed row would sit in
   *   `uncertain` forever with no preparer able to take it - worse than staying parked, because a
   *   parked row is at least visible in the operator queue. Resuming there would also invite
   *   rebuilding an input whose previous copy may already have been consumed by the Execution.
   *
   * A run with no disconnected axis, or one parked where resuming cannot help, answers 409.
   */
  async resumeDisconnectedRun(runId: string): Promise<ReviewRunRecord> {
    const run = await findRunRecord(this.pool, this.connectorId, runId)
    if (run === null)
      throw Object.assign(new Error(`Review run does not exist: ${runId}`), {
        statusCode: 404
      })
    // Preparation is checked first because it can park only by contradicting execution, so a
    // disconnected preparation tells us something about the other axes too: if execution also
    // moved on, resuming execution would leave the preparation stalled with no preparer able to
    // take it. Checking execution first would report such a run as resumable.
    if (run.preparation.status === 'disconnected') {
      if (run.execution.status === 'pending')
        return await this.resumeDisconnectedPreparation(runId)
      throw Object.assign(
        new Error(
          `Review run ${runId} cannot be resumed: its preparation is disconnected and execution already moved past pending.`
        ),
        { statusCode: 409 }
      )
    }
    if (run.execution.status === 'disconnected')
      return await this.resumeDisconnectedExecution(runId)
    if (run.publication.status === 'disconnected')
      return await this.resumeDisconnectedPublication(runId)
    throw Object.assign(
      new Error(`Review run ${runId} has no resumable disconnected axis.`),
      { statusCode: 409 }
    )
  }

  /** Hand a parked publication back to automatic recovery.
   *
   * The counterpart of `resumeDisconnectedPreparation` for the other axis that can park. Like
   * it, this returns the budgets the park consumed: the parked steps become attemptable again,
   * so the side effects they name are issued once more rather than only looked for. Steps that
   * already succeeded keep their status, so the run resumes where it stopped. */
  async resumeDisconnectedPublication(runId: string): Promise<ReviewRunRecord> {
    return await transaction(this.pool, async (client) => {
      if (!(await this.publications.resumeDisconnectedOn(client, runId)))
        throw Object.assign(
          new Error(`Review run ${runId} is not a disconnected publication.`),
          { statusCode: 409 }
        )
      const record = await findRunRecord(client, this.connectorId, runId)
      if (record === null)
        throw new Error(`Review run ${runId} disappeared during resumption.`)
      return record
    })
  }
  /** Stop waiting for a disconnected run; see the three single-axis decisions below.
   *
   * `abandonBlockedPreparation` concludes a preparation contradicted by execution state. This
   * operation concludes an axis whose remote outcome remains unknown. Neither decision records
   * that the task never ran. */
  async giveUpDisconnectedRun(
    runId: string,
    reason: string
  ): Promise<ReviewRunRecord> {
    if (reason.trim() === '')
      throw Object.assign(new Error('A reason is required.'), {
        statusCode: 400
      })
    const run = await findRunRecord(this.pool, this.connectorId, runId)
    if (run === null)
      throw Object.assign(new Error(`Review run does not exist: ${runId}`), {
        statusCode: 404
      })
    if (run.preparation.status === 'disconnected')
      return await this.giveUpDisconnectedPreparation(runId, reason)
    if (run.execution.status === 'disconnected')
      return await this.giveUpDisconnectedExecution(runId, reason)
    if (run.publication.status === 'disconnected')
      return await this.giveUpDisconnectedPublication(runId, reason)
    throw Object.assign(
      new Error(`Review run ${runId} has no disconnected axis to give up.`),
      { statusCode: 409 }
    )
  }

  /** Conclude a disconnected preparation as a failure at the operator's request.
   *
   * The preparation ends `failed` with `PREPARATION_GIVEN_UP_BY_OPERATOR`, which says what
   * actually happened: the operator declined to keep waiting, not that the input was bad. */
  private async giveUpDisconnectedPreparation(
    runId: string,
    reason: string
  ): Promise<ReviewRunRecord> {
    return await transaction(this.pool, async (client) => {
      const gaveUp = await client.query(
        `UPDATE preparations
         SET status='failed', claim_token=NULL, claimed_at=NULL,
             failure_code='PREPARATION_GIVEN_UP_BY_OPERATOR',
             failure_message=$3,
             last_failure_code='PREPARATION_GIVEN_UP_BY_OPERATOR',
             last_failure_message=$3,
             finished_at=clock_timestamp(), disconnect_reason=NULL,
             updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='disconnected'`,
        [runId, this.connectorId, reason]
      )
      if (gaveUp.rowCount !== 1)
        throw Object.assign(
          new Error(`Review run ${runId} is not a disconnected preparation.`),
          { statusCode: 409 }
        )
      const eventId = await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'preparation',
        fromStatus: 'disconnected',
        toStatus: 'failed',
        reasonCode: 'PREPARATION_GIVEN_UP_BY_OPERATOR'
      })
      await queueRunNotice(client, {
        runId,
        connectorId: this.connectorId,
        sourceEventId: eventId,
        kind: 'failure',
        axis: 'preparation',
        reasonCode: 'PREPARATION_GIVEN_UP_BY_OPERATOR'
      })
      const publicationFrom = await abandonInFlightPublication(
        client,
        this.connectorId,
        runId
      )
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
      const record = await findRunRecord(client, this.connectorId, runId)
      if (record === null)
        throw new Error(`Review run ${runId} disappeared during the decision.`)
      return record
    })
  }

  /** Stop waiting for a disconnected execution at the operator's request.
   *
   * The task ends `failed` with `SUBMISSION_RECOVERY_ABANDONED_BY_OPERATOR`. That code is chosen
   * over anything resembling "never ran" on purpose: the Execution may have accepted this task and
   * may be running it right now. What ends is this run's willingness to find out. Publication is
   * skipped because no result will be delivered, not because none exists. */
  private async giveUpDisconnectedExecution(
    runId: string,
    reason: string
  ): Promise<ReviewRunRecord> {
    return await transaction(this.pool, async (client) => {
      const gaveUp = await client.query(
        `UPDATE executions
         SET status='failed', claim_token=NULL, claimed_at=NULL,
             failure_code='SUBMISSION_RECOVERY_ABANDONED_BY_OPERATOR',
             failure_message=$3,
             finished_at=COALESCE(finished_at, clock_timestamp()),
             observed_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='disconnected'`,
        [runId, this.connectorId, reason]
      )
      if (gaveUp.rowCount !== 1)
        throw Object.assign(
          new Error(`Review run ${runId} is not a disconnected execution.`),
          { statusCode: 409 }
        )
      const eventId = await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'execution',
        fromStatus: 'disconnected',
        toStatus: 'failed',
        reasonCode: 'SUBMISSION_RECOVERY_ABANDONED_BY_OPERATOR'
      })
      await queueRunNotice(client, {
        runId,
        connectorId: this.connectorId,
        sourceEventId: eventId,
        kind: 'failure',
        axis: 'execution',
        reasonCode: 'SUBMISSION_RECOVERY_ABANDONED_BY_OPERATOR'
      })
      const publicationFrom = await abandonInFlightPublication(
        client,
        this.connectorId,
        runId
      )
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
      const record = await findRunRecord(client, this.connectorId, runId)
      if (record === null)
        throw new Error(`Review run ${runId} disappeared during the decision.`)
      return record
    })
  }

  /** Stop publishing at the operator's request, after a step's outcome could not be established.
   *
   * The axis ends `failed`, deliberately not `skipped`: `skipped` reads as "nothing was
   * published", and a step in this state may already have taken effect remotely. Failing says
   * the honest thing — publishing was stopped, and what is actually on the remote system is
   * unknown — while still releasing the run so it stops waiting. The steps keep their
   * `disconnected` status as the record of which one could not be concluded. */
  private async giveUpDisconnectedPublication(
    runId: string,
    reason: string
  ): Promise<ReviewRunRecord> {
    return await transaction(this.pool, async (client) => {
      const gaveUp = await client.query(
        `UPDATE publications
         SET status='failed', claim_token=NULL, claimed_at=NULL,
             failure_code='PUBLICATION_ABANDONED_BY_OPERATOR',
             failure_message=$3,
             finished_at=COALESCE(finished_at, clock_timestamp()),
             updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='disconnected'`,
        [runId, this.connectorId, reason]
      )
      if (gaveUp.rowCount !== 1)
        throw Object.assign(
          new Error(`Review run ${runId} is not a disconnected publication.`),
          { statusCode: 409 }
        )
      const eventId = await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'publication',
        fromStatus: 'disconnected',
        toStatus: 'failed',
        reasonCode: 'PUBLICATION_ABANDONED_BY_OPERATOR'
      })
      await queueRunNotice(client, {
        runId,
        connectorId: this.connectorId,
        sourceEventId: eventId,
        kind: 'failure',
        axis: 'publication',
        reasonCode: 'PUBLICATION_ABANDONED_BY_OPERATOR'
      })
      const record = await findRunRecord(client, this.connectorId, runId)
      if (record === null)
        throw new Error(`Review run ${runId} disappeared during the decision.`)
      return record
    })
  }

  /** Hand a disconnected execution back to automatic replay; see the execution store.
   *
   * The last axis that can park. Its only alternative is abandoning the run, so without this a
   * run whose replays never resolved stays stuck with no owner and no writer. */
  async resumeDisconnectedExecution(runId: string): Promise<ReviewRunRecord> {
    return await transaction(this.pool, async (client) => {
      if (
        !(await this.executions.resumeDisconnectedSubmissionRecoveryOn(
          client,
          runId
        ))
      )
        throw Object.assign(
          new Error(`Review run ${runId} is not a disconnected execution.`),
          { statusCode: 409 }
        )
      const record = await findRunRecord(client, this.connectorId, runId)
      if (record === null)
        throw new Error(`Review run ${runId} disappeared during resumption.`)
      return record
    })
  }
  /** Hand a disconnected preparation back to automatic recovery.
   *
   * The only legitimate way out of `disconnected` other than abandoning. It does not repair
   * anything and does not assert an outcome: it clears the reason and puts the row back in
   * `uncertain`, because after an operator has intervened nobody yet knows whether the prepared
   * input reached Review Runs. Recovery then re-establishes that the same way it always does.
   *
   * `attempt_count` is reset to zero. Disconnection is reached when the attempt budget (`MAX_PREPARATION_ATTEMPTS`)
   * is spent, so a row resumed with its count intact would be concluded as failed by the very
   * next expired lease, and the operator's decision would never get an attempt to act on. The
   * reset is what makes the resume a real hand-back: it grants a fresh budget, not a fresh fact.
   * The grant is bounded on purpose — each resumed run gets one more budget, and the operator
   * decision that the logs record is the only source of extra attempts.
   *
   * A run that is not disconnected answers 409, the same "this run is not in a state this
   * operation may act on" rule the abandonment uses. */
  async resumeDisconnectedPreparation(runId: string): Promise<ReviewRunRecord> {
    return await transaction(this.pool, async (client) => {
      const resumed = await client.query(
        `UPDATE preparations
         SET status='uncertain', disconnect_reason=NULL, attempt_count=0,
             available_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='disconnected'`,
        [runId, this.connectorId]
      )
      if (resumed.rowCount !== 1)
        throw Object.assign(
          new Error(`Review run ${runId} is not a disconnected preparation.`),
          { statusCode: 409 }
        )
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'preparation',
        fromStatus: 'disconnected',
        toStatus: 'uncertain',
        reasonCode: 'PREPARATION_RESUMED_BY_OPERATOR'
      })
      const record = await findRunRecord(client, this.connectorId, runId)
      if (record === null)
        throw new Error(`Review run ${runId} disappeared during resumption.`)
      return record
    })
  }

  /** Recoverable runs, as a projection rather than a bare array: a row the contract cannot
   * represent is returned in `dropped` instead of aborting the read.
   *
   * An uncertain submission is recoverable when it has no live claim, or when its claim has
   * expired, so a stalled recovery becomes claimable again. The lease is `claimed_at`; the
   * observation heartbeat writes `observed_at` only, so it can never extend this lease. */
}
