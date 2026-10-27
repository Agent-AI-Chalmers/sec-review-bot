// Implements Review Runs's durable review trunk and orchestrates cross-axis transitions that
// must move more than one lifecycle axis in one transaction. Read-model queries live in
// `review-run-queries.ts`; SQL row projection lives in `run-record-projection.ts`; and
// operator-only cross-axis decisions live in `operator-decision-store.ts`.
//
// Axis ownership:
// - `execution-store.ts` owns single-axis execution writes (status transitions, observation
//   heartbeat, artifact/result, submission-recovery claims).
// - `preparation-store.ts` / `publication-store.ts` own their own axes.
// - This store owns the run trunk and normal cross-axis transitions (submit -> queued, execution
//   failure -> publication skipped, rejected replay -> publication skipped). A cross-axis
//   transition is owned by the axis that initiates it; preparations initiating an execution skip
//   is therefore in that store.
// - `publication-abandon.ts` holds the one transition shared by more than one axis: concluding a
//   publication that can never publish. It is separate because both preparation and execution
//   trigger it, and single-axis stores must not import each other (this store is what constructs
//   them). It is still a cross-axis write, kept atomic by taking the caller's transaction.
//
// Publication has no reversion into it: an uncertain submission leaves publication `pending`
// rather than skipping it, so neither an accepted nor a rejected replay has a publication
// transition to undo.
// Claim tokens here are the sole fencing authority for writes.
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

import type { ExecutionArtifactStorage } from '../contracts.js'
import {
  applySchemaVersions,
  KNOWN_SCHEMA_VERSIONS
} from '../database/schema-version-runner.js'
import { transaction } from '../database/transaction.js'
import {
  normalizeArtifactStorage,
  type CreateReviewRunArgs,
  type PublicationStatus,
  type PublicationStepRecord,
  type PublicationWork,
  type ReviewRunAdmission,
  type ReviewRunEvent,
  type ExecutionStatisticsSummary,
  type ReviewRunRecord
} from '../shapes.js'
import {
  PreparationStore,
  type PreparationExpiryResult,
  type RunNoticeWork,
  type PreparationWork
} from './preparation-store.js'
import { PublicationStore } from './publication-store.js'
import { abandonInFlightPublication } from './publication-abandon.js'
import { appendEvent } from './review-run-events.js'
import { OperatorDecisionStore } from './operator-decision-store.js'
import {
  ReviewRunQueries,
  type DroppedRunRow,
  type ListRunsOptions,
  type ParkedRun,
  type RunRowsProjection
} from './review-run-queries.js'
import {
  RUN_SELECT,
  rowToRecord,
  type ReviewRunRow
} from './run-record-projection.js'
import { queueRunNotice } from './run-notices.js'
import { ExecutionStore } from './execution-store.js'

export type {
  CreateReviewRunArgs,
  PreparationStatus,
  PublicationStatus,
  PublicationStepRecord,
  PublicationWork,
  ReviewRunAdmission,
  ReviewRunRecord,
  ExecutionStatus
} from '../shapes.js'

type JsonObject = Record<string, unknown>
export type PublishContext = JsonObject

const DEFAULT_CLAIM_TIMEOUT_MS = 10 * 60 * 1000
const CLAIM_WAIT_INTERVAL_MS = 250

export type {
  PreparationExpiryBlocked,
  PreparationExpiryResult,
  RunNoticeWork,
  PreparationWork
} from './preparation-store.js'
export type {
  DroppedRunRow,
  ParkedRun,
  RunRowsProjection
} from './review-run-queries.js'

export class ReviewRunStore {
  private readonly pool: Pool
  readonly connectorId: string
  readonly sourcePlatform: ReviewRunRecord['source_platform']
  private readonly claimTimeoutMs: number
  private readonly preparations: PreparationStore
  private readonly publications: PublicationStore
  private readonly executions: ExecutionStore
  private readonly operatorDecisions: OperatorDecisionStore
  private readonly queries: ReviewRunQueries
  private initialized = false

  constructor({
    connectionString,
    connectorId = process.env.CONNECTOR_ID?.trim() ||
      'github-integration:default',
    sourcePlatform = 'github',
    claimTimeoutMs = DEFAULT_CLAIM_TIMEOUT_MS,
    pool,
    onDroppedRunRow = () => {}
  }: {
    connectionString?: string
    connectorId?: string
    sourcePlatform?: ReviewRunRecord['source_platform']
    claimTimeoutMs?: number
    pool?: Pool
    /** Reports a stored row the record contract cannot represent. Fan-out reads already return
     * those in `dropped` for the caller to report; this covers the single-run read, which has no
     * such list and would otherwise discard the fault silently. */
    onDroppedRunRow?: (dropped: DroppedRunRow) => void
  } = {}) {
    this.pool = pool ?? new Pool({ connectionString })
    // `pg` emits `error` on the pool when an idle client loses its connection, and an
    // EventEmitter that emits `error` without a listener throws. A database restart, a
    // network blip, or the server reaping an idle connection would therefore kill this
    // process -- taking down every other compose service with it, because the deployment
    // runs `up --abort-on-container-failure`.
    //
    // The event carries no query to fail: the client that died was idle, so whoever needed
    // it next will get a fresh connection or a normal query error. Log it and keep running
    // rather than treating a recoverable pool event as a fatal process error.
    //
    // Only the message is logged. Printing the Error itself expands the whole pg client --
    // socket, buffer state, type parsers -- into hundreds of lines per connection, and a
    // restart severs every pooled connection at once.
    this.pool.on('error', (error: Error) => {
      console.error('review_runs_pool_idle_client_error', error.message)
    })
    this.connectorId = connectorId
    this.sourcePlatform = sourcePlatform
    this.claimTimeoutMs = Math.max(0, claimTimeoutMs)
    this.preparations = new PreparationStore(
      this.pool,
      this.connectorId,
      this.claimTimeoutMs
    )
    this.publications = new PublicationStore(
      this.pool,
      this.connectorId,
      this.claimTimeoutMs
    )
    this.executions = new ExecutionStore(
      this.pool,
      this.connectorId,
      this.claimTimeoutMs
    )
    this.operatorDecisions = new OperatorDecisionStore(
      this.pool,
      this.connectorId,
      this.publications,
      this.executions
    )
    this.queries = new ReviewRunQueries(
      this.pool,
      this.connectorId,
      this.claimTimeoutMs,
      onDroppedRunRow
    )
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await applySchemaVersions(this.pool)
    this.initialized = true
  }

  /** Verify the dependency boundary required to accept coordination requests. */
  async checkReadiness(): Promise<void> {
    this.ready()
    const result = await this.pool.query<{ version: number }>(
      'SELECT version FROM schema_versions ORDER BY version'
    )
    const appliedVersions = result.rows.map(({ version }) => version)
    if (
      appliedVersions.length !== KNOWN_SCHEMA_VERSIONS.length ||
      appliedVersions.some(
        (version, index) => version !== KNOWN_SCHEMA_VERSIONS[index]
      )
    ) {
      throw new Error('Review Runs schema ledger is not current.')
    }
  }

  private ready(): void {
    if (!this.initialized)
      throw new Error('ReviewRunStore.initialize() must complete before use.')
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
    // Admission itself takes the first preparation claim, so the preparation phase starts here
    // as well as in `claimNext`: a run admitted and prepared in one request must not show a null
    // start just because it never went back through the pending queue.
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
      `
      INSERT INTO publications (run_id,connector_id,input,status)
      VALUES ($1,$2,$3::jsonb,'pending')
    `,
      [run.run_id, this.connectorId, JSON.stringify(run.publish_context)]
    )
    // Admission is the first transition on both axes: execution starts `pending` (input not
    // yet submitted) and a preparation row is created already owned by this admission's claim.
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
  async createPreparingReviewRun(
    run: CreateReviewRunArgs
  ): Promise<ReviewRunAdmission> {
    this.ready()
    return await transaction(
      this.pool,
      async (client) => await this.insertWith(client, run)
    )
  }
  async admitReviewRun(
    run: CreateReviewRunArgs &
      Required<Pick<CreateReviewRunArgs, 'ingress_kind' | 'ingress_key'>>
  ): Promise<ReviewRunAdmission> {
    this.ready()
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
        // Ingress replay is an idempotent read. The preparation coordinator is
        // the sole owner of post-admission claims, including lease recovery.
        return {
          record: rowToRecord(row),
          created: false,
          preparation_token: null
        }
      })
    } catch (error: unknown) {
      if (!(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ))
        throw error
      // A concurrent transaction won the ingress identity. Read its durable run
      // after PostgreSQL rolls back this transaction.
      const existing = await this.pool.query<ReviewRunRow>(
        `${RUN_SELECT}
        WHERE r.connector_id=$1 AND r.ingress_kind=$2 AND r.ingress_key=$3`,
        [this.connectorId, run.ingress_kind, run.ingress_key]
      )
      if (existing.rows[0] === undefined) {
        // The unique violation came from a concurrent admission that is not visible afterwards,
        // which means it rolled back. Re-throwing the raw 23505 would report a database
        // constraint to a caller that asked for an idempotent admission, so say what happened.
        throw new Error(
          `ingress replay for ${run.ingress_kind}:${run.ingress_key} lost a concurrent ` +
            `admission that rolled back; the request can be retried`,
          { cause: error }
        )
      }
      return {
        record: rowToRecord(existing.rows[0]),
        created: false,
        preparation_token: null
      }
    }
  }
  async savePreparedSubmission(
    runId: string,
    token: string,
    context: PublishContext,
    input: JsonObject
  ): Promise<void> {
    // Both axes are written by one statement, but a single statement is not a transaction here:
    // every data-modifying CTE runs, and the trailing `SELECT ... WHERE EXISTS` only decides how
    // many rows are returned. So when the execution arm matches nothing, the publication arm has
    // already changed `publications.input`, and checking `rowCount` on a bare `pool.query` would
    // throw after that half-write had auto-committed. Wrapping the statement lets the same check
    // roll the publication back, keeping the two axes atomic like every other cross-axis write.
    await transaction(this.pool, async (client) => {
      // Read the workflow inside the transaction, not before it: the value feeds a predicate the
      // writes below depend on, and a read outside would be a separate snapshot from the one that
      // decides whether they match.
      const run = await this.getWith(client, runId)
      if (run === null) throw new Error(`Review run does not exist: ${runId}`)
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
          run.workflow
        ]
      )
      if (result.rowCount !== 1)
        throw new Error(
          `Review run ${runId} cannot save prepared submission outside pending.`
        )
    })
  }
  async renewPreparationClaim(runId: string, token: string): Promise<boolean> {
    this.ready()
    return await this.preparations.renewClaim(runId, token)
  }
  async claimNextPreparation(): Promise<PreparationWork | null> {
    this.ready()
    return await this.preparations.claimNext()
  }
  async checkpointPreparationInput(
    runId: string,
    token: string,
    input: JsonObject
  ): Promise<void> {
    this.ready()
    await this.preparations.checkpointInput(runId, token, input)
  }
  async claimNextRunNotice(): Promise<RunNoticeWork | null> {
    this.ready()
    return await this.preparations.claimNextRunNotice()
  }
  async completeRunNotice(
    noticeId: string,
    token: string,
    delivered: boolean,
    commentUrl?: string | null
  ): Promise<boolean> {
    this.ready()
    return await this.preparations.completeRunNotice(
      noticeId,
      token,
      delivered,
      commentUrl
    )
  }
  preparationHeartbeatIntervalMs(): number {
    return this.preparations.heartbeatIntervalMs()
  }
  async markQueued(
    runId: string,
    token: string,
    context: PublishContext
  ): Promise<void> {
    return await transaction(this.pool, async (client) => {
      const run = await this.getWith(client, runId)
      if (run === null)
        // The run id came from the caller, so a missing run is a 4xx, not a server fault.
        // Without `statusCode` the HTTP layer would report it as 500 and hide the real cause.
        throw Object.assign(new Error(`Review run does not exist: ${runId}`), {
          statusCode: 404
        })
      // Submitting the prepared input asserts the same premise a replay does: the publication is
      // still pending, because the run may now succeed and its result must remain deliverable.
      // Without the status check this row would accept the new input even after another path had
      // concluded the publication, and the execution below would then queue a run whose result
      // can never be published. Matching no row fails the whole transaction.
      const result = await client.query(
        `
        UPDATE publications
        SET input=$2::jsonb, updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$3
          AND status='pending'
          AND EXISTS (
            SELECT 1 FROM review_runs r
            WHERE r.run_id=publications.run_id AND r.connector_id=$3 AND r.workflow=$4
          )
      `,
        [runId, JSON.stringify(context), this.connectorId, run.workflow]
      )
      const queued = await client.query(
        `
        UPDATE executions
        SET status='queued', started_at=COALESCE(started_at, clock_timestamp()),
            failure_code=NULL, failure_message=NULL,
            observed_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$3
          AND status='pending' AND EXISTS (
            SELECT 1 FROM preparations
            WHERE preparations.run_id=executions.run_id
              AND preparations.connector_id=$3 AND preparations.status='preparing'
              AND preparations.claim_token=$2
          )
      `,
        [runId, token, this.connectorId]
      )
      if (result.rowCount !== 1 || queued.rowCount !== 1)
        throw new Error(
          `Review run ${runId} cannot transition from pending to queued.`
        )
      const completed = await client.query(
        `UPDATE preparations
         SET status='submitted', claim_token=NULL, claimed_at=NULL,
             finished_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE run_id=$1 AND connector_id=$2 AND status='preparing'
           AND claim_token=$3`,
        [runId, this.connectorId, token]
      )
      if (completed.rowCount !== 1)
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
  async runExists(runId: string): Promise<boolean> {
    this.ready()
    return await this.queries.runExists(runId)
  }
  async listEvents(runId: string): Promise<ReviewRunEvent[]> {
    this.ready()
    return await this.queries.listEvents(runId)
  }
  async getRun(runId: string): Promise<ReviewRunRecord | null> {
    this.ready()
    return await this.queries.getRun(runId)
  }
  async getExecutionStatistics(
    runIds: readonly string[]
  ): Promise<Map<string, ExecutionStatisticsSummary>> {
    this.ready()
    return await this.queries.getExecutionStatistics(runIds)
  }
  async listRunsPage(options: ListRunsOptions = {}): Promise<{
    runs: ReviewRunRecord[]
    next_cursor: string | null
    dropped: DroppedRunRow[]
  }> {
    this.ready()
    return await this.queries.listRunsPage(options)
  }
  async expireStalePreparations(): Promise<PreparationExpiryResult> {
    this.ready()
    return await this.preparations.expireStale()
  }
  async listParkedRuns(): Promise<ParkedRun[]> {
    this.ready()
    return await this.queries.listParkedRuns()
  }

  async abandonBlockedPreparation(
    runId: string,
    reason: string
  ): Promise<ReviewRunRecord> {
    this.ready()
    return await this.operatorDecisions.abandonBlockedPreparation(runId, reason)
  }

  async resumeDisconnectedRun(runId: string): Promise<ReviewRunRecord> {
    this.ready()
    return await this.operatorDecisions.resumeDisconnectedRun(runId)
  }

  async resumeDisconnectedPublication(runId: string): Promise<ReviewRunRecord> {
    this.ready()
    return await this.operatorDecisions.resumeDisconnectedPublication(runId)
  }

  async giveUpDisconnectedRun(
    runId: string,
    reason: string
  ): Promise<ReviewRunRecord> {
    this.ready()
    return await this.operatorDecisions.giveUpDisconnectedRun(runId, reason)
  }

  async resumeDisconnectedExecution(runId: string): Promise<ReviewRunRecord> {
    this.ready()
    return await this.operatorDecisions.resumeDisconnectedExecution(runId)
  }

  async resumeDisconnectedPreparation(runId: string): Promise<ReviewRunRecord> {
    this.ready()
    return await this.operatorDecisions.resumeDisconnectedPreparation(runId)
  }

  async listSubmissionRecoveries(): Promise<RunRowsProjection> {
    this.ready()
    return await this.queries.listSubmissionRecoveries()
  }
  async claimSubmissionRecovery(runId: string): Promise<string | null> {
    return await this.executions.claimSubmissionRecovery(runId)
  }
  /** How many replays of an uncertain submission ended with the outcome still unknown. */
  async submissionRecoveryAttemptCount(runId: string): Promise<number | null> {
    const result = await this.pool.query<{ attempt_count: number }>(
      `SELECT attempt_count FROM executions
       WHERE run_id=$1 AND connector_id=$2`,
      [runId, this.connectorId]
    )
    const row = result.rows[0]
    return row === undefined ? null : row.attempt_count
  }
  /** Stop automatic recovery once its unknown-outcome budget is spent. */
  async disconnectExhaustedSubmissionRecovery(
    runId: string,
    maxAttempts: number
  ): Promise<boolean> {
    return await this.executions.disconnectExhaustedSubmissionRecovery(
      runId,
      maxAttempts
    )
  }
  /** Count a replay whose outcome is still unknown; the axis stays `uncertain`. */
  async recordUnknownRecoveryOutcome(
    runId: string,
    token: string
  ): Promise<boolean> {
    return await this.executions.recordUnknownRecoveryOutcome(runId, token)
  }
  /** Commit an accepted replay: the submission is confirmed, so execution is now queued.
   *
   * `started_at` is filled here, not when the run entered `uncertain`: that state records an
   * unconfirmed submission, so it deliberately has no start. A resolved replay means the Execution
   * did accept it, making this the instant execution actually began. Leaving it NULL would
   * produce a `queued` run with no start, a state no other path can reach. */
  async completeSubmissionRecovery(
    runId: string,
    token: string
  ): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      // An uncertain submission keeps publication pending, so a successful replay moves only the
      // execution axis and needs no publication change. The EXISTS clause asserts that premise
      // instead of assuming it: if some other path already concluded the publication (skipped or
      // failed), queueing the execution would leave a run that is running while its result can no
      // longer be delivered. Matching nothing returns false, which the caller reports as a lost
      // claim instead of committing that inconsistent snapshot.
      const result = await client.query(
        `
        UPDATE executions
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
          )
      `,
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
  /** Conclude an uncertain submission that will not resolve: the run really did not start.
   *
   * This is the only path allowed to tell the requester that an uncertain run failed. Entering
   * `uncertain` means the outcome is unknown, so a notice there would announce a failure the run
   * may still disprove by being accepted on replay; a notice is therefore created here, in the
   * same transaction that turns that uncertainty into a conclusion. Both ways of getting here —
   * the Execution rejecting the replay, and the replay budget running out — mean the run has no
   * result, so both skip publication and both queue the notice.
   */
  async failSubmissionRecovery(
    runId: string,
    token: string,
    error: { code?: string | null; message: string }
  ): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      const result = await client.query(
        `
        UPDATE executions
        SET status='failed', claim_token=NULL, claimed_at=NULL,
            failure_code=$4, failure_message=$5,
            finished_at=clock_timestamp(),
            observed_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE run_id=$1 AND connector_id=$2
          AND status='uncertain' AND claim_token=$3
      `,
        [runId, this.connectorId, token, error.code ?? null, error.message]
      )
      if (result.rowCount !== 1) return false
      // A rejected replay proves there is nothing to publish: converge a publication that is
      // still pending or in flight, in this same transaction.
      const fromStatus = await abandonInFlightPublication(
        client,
        this.connectorId,
        runId
      )
      // The requester is told here and nowhere earlier: entering `uncertain` queues no notice,
      // so the comment a requester reads is never one the replay could contradict. The notice is
      // keyed by this event, not by the run, so it cannot collide with a notice some other
      // transition queued - the row is unique per source event, which is what makes a second
      // write of this same transition a no-op instead of a second comment.
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
      if (fromStatus !== null) {
        await appendEvent(client, {
          runId,
          connectorId: this.connectorId,
          axis: 'publication',
          fromStatus,
          toStatus: 'skipped',
          // The publication was abandoned because execution was conclusively rejected, not for
          // the rejection's own reason: that code belongs to the execution event above. Keeping it
          // constant is what lets the contract declare this edge's reason exactly.
          reasonCode: 'PUBLICATION_ABANDONED'
        })
      }
      return true
    })
  }
  /** Active (queued/running) runs for this connector, as a projection: a row the contract
   * cannot represent is returned in `dropped` instead of aborting the read for every run. */
  async listActiveRuns(): Promise<RunRowsProjection> {
    this.ready()
    return await this.queries.listActiveRuns()
  }
  /** Record that the Execution was observed just now, without changing state. Writes only
   * `observed_at`, so a heartbeat can never extend the recovery lease. */
  async touchObservation(runId: string): Promise<void> {
    return await this.executions.touchObservation(runId)
  }
  async markRunning(runId: string): Promise<boolean> {
    return await this.executions.markRunning(runId)
  }
  async recordArtifactStorage(
    runId: string,
    storage: ExecutionArtifactStorage | undefined
  ): Promise<void> {
    return await this.executions.recordArtifactStorage(runId, storage)
  }
  async recordExecutionSuccess(
    runId: string,
    workflowResult: unknown,
    storage: ExecutionArtifactStorage | undefined
  ): Promise<boolean> {
    return await this.executions.recordExecutionSuccess(
      runId,
      workflowResult,
      storage
    )
  }
  async failExecution(
    runId: string,
    error: { code?: string | null; message: string },
    storage?: ExecutionArtifactStorage
  ): Promise<boolean> {
    return await transaction(this.pool, async (client) => {
      // As with success, capture the pre-update status so the event names the real origin.
      const run = await client.query<{ from_status: string }>(
        `
        WITH previous AS (
          SELECT run_id, status FROM executions
          WHERE run_id=$1 AND connector_id=$2 AND status IN ('queued','running')
          FOR UPDATE
        )
        UPDATE executions e
        SET status='failed', claim_token=NULL, claimed_at=NULL,
            failure_code=$3, failure_message=$4, artifact_storage=$5::jsonb,
            finished_at=clock_timestamp(),
            observed_at=clock_timestamp(), updated_at=clock_timestamp()
        FROM previous
        WHERE e.run_id=previous.run_id
        RETURNING previous.status AS from_status
      `,
        [
          runId,
          this.connectorId,
          error.code ?? null,
          error.message,
          storage === undefined
            ? null
            : JSON.stringify(normalizeArtifactStorage(storage, `run ${runId}`))
        ]
      )
      if (run.rowCount !== 1) return false
      // A terminal execution failure ends the run, so the requester is told about it. The notice is
      // keyed by the run rather than by preparation: this failure is not a preparation failure,
      // and leaving it unannounced meant a run could stop partway with no reply ever posted.
      // A terminal Execution failure has no result to publish. Keep the publication row only as the
      // durable declaration that publication is not applicable, converging an in-flight one too.
      const fromStatus = await abandonInFlightPublication(
        client,
        this.connectorId,
        runId
      )
      const executionEventId = await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'execution',
        fromStatus: run.rows[0]?.from_status ?? null,
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
      // The publication axis moved too; record it so the audit trail matches the snapshot. The
      // returned status keeps the event honest when the publication was already concluded.
      if (fromStatus !== null) {
        await appendEvent(client, {
          runId,
          connectorId: this.connectorId,
          axis: 'publication',
          fromStatus,
          toStatus: 'skipped',
          reasonCode: 'PUBLICATION_ABANDONED'
        })
      }
      return true
    })
  }
  /** Claim one known run for publication.
   *
   * Inlined here rather than forwarded to `PublicationStore`: the claim condition reads the
   * execution axis (`executions.status='succeeded'` and a non-null workflow_result), so it is
   * cross-axis orchestration, not a single-axis publication write.
   *
   * A claimable run must have a JSON result that is not the JSON value `null`: `IS NOT NULL`
   * accepts a stored JSON `null`, but node-pg reads it back as JS `null`, which would poison
   * the claim path. Excluding it keeps a null-result run from blocking publication for every
   * other run behind it.
   *
   * `started_at` is set on the first claim only: a retryable failure returns the row to
   * pending and it is claimed again, and that must not move when the publication phase began. */
  async claimPublication(runId: string): Promise<string | null> {
    const token = crypto.randomUUID()
    return await transaction(this.pool, async (client) => {
      // `uncertain` is claimable on an expired lease for the same reason `publishing` is. The
      // axis reports a step's uncertainty while a live publisher reconciles it, but if that
      // publisher dies nothing else moves the row: claiming the axis is the only way in, and the
      // step-level writes require the axis claim. Excluding it would park the run for automated
      // work, reachable only through an operator resume. A live lease is never stolen either way.
      //
      // Capture the pre-update state so the audit event names where the claim came from: a fresh
      // `pending` claim versus reclaiming an expired lease (`publishing`, or `uncertain` whose
      // reconciling owner died).
      const result = await client.query<{
        claim_token: string
        from_status: PublicationStatus
      }>(
        `
        WITH previous AS (
          SELECT run_id, status FROM publications
          WHERE run_id=$1 AND connector_id=$3
          FOR UPDATE
        )
        UPDATE publications p
        SET status='publishing', claim_token=$2, claimed_at=clock_timestamp(),
            started_at=COALESCE(p.started_at, clock_timestamp()),
            failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
        FROM previous, executions e
        WHERE p.run_id=previous.run_id AND previous.run_id=$1 AND p.connector_id=$3
          AND e.run_id=p.run_id AND e.connector_id=p.connector_id
          AND e.status='succeeded' AND jsonb_typeof(e.workflow_result) <> 'null'
          AND NOT EXISTS (SELECT 1 FROM publication_steps s
            WHERE s.run_id=p.run_id AND s.connector_id=p.connector_id
              AND s.status='disconnected')
          AND (
            previous.status='pending'
            OR (previous.status IN ('publishing','uncertain')
              AND p.claimed_at <= clock_timestamp()-($4*interval '1 millisecond'))
          )
        RETURNING p.claim_token, previous.status AS from_status
      `,
        [runId, token, this.connectorId, this.claimTimeoutMs]
      )
      const claimed = result.rows[0]
      if (claimed === undefined) return null
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'publication',
        fromStatus: claimed.from_status,
        toStatus: 'publishing',
        reasonCode:
          claimed.from_status === 'publishing' ||
          claimed.from_status === 'uncertain'
            ? 'PUBLICATION_LEASE_EXPIRED'
            : null
      })
      return claimed.claim_token
    })
  }
  /**
   * Claim the next publishable run, optionally holding the request until one appears.
   *
   * Like `claimPublication`, this stays here because selecting publishable work joins the
   * execution axis and the result is a full cross-axis record.
   *
   * The wait lives here because the state it looks for is in this database: a re-check
   * costs one indexed query per tick for the single caller that waits. Waiting on a
   * remote service is a different trade, since there each re-check is a round trip per
   * watched item — which is why the Execution status query deliberately offers no such
   * option.
   */
  async claimNextPublication(waitMs = 0): Promise<PublicationWork | null> {
    // The contract declares `wait_ms` a non-negative integer, so the handler passes a value the
    // schema already bounded below. Clamp it here anyway: the cap keeps one request from holding
    // a connection longer than intended, and a store method should not assume its caller
    // validated on its behalf.
    const boundedWaitMs =
      Number.isFinite(waitMs) && waitMs > 0 ? Math.min(waitMs, 30_000) : 0
    const deadline = Date.now() + boundedWaitMs
    for (;;) {
      const work = await this.claimNextPublicationOnce()
      if (work !== null || Date.now() >= deadline) return work
      await new Promise((resolve) =>
        setTimeout(resolve, CLAIM_WAIT_INTERVAL_MS)
      )
    }
  }

  /** Claim the oldest publishable run for this connector.
   *
   * The SELECT applies the same JSON-`null` guard as `claimPublication`: a stored JSON `null`
   * result must not be selected as claimable work, or the claim would throw and roll back on the
   * same row on every poll. Its status predicate is the same one too: an expired lease of a
   * `publishing` or `uncertain` row is claimable, and a live one is never taken.
   *
   * `started_at` is written with `COALESCE` so only the first claim marks when the publication
   * phase began; a retryable failure returns the row to pending and is claimed again. */
  private async claimNextPublicationOnce(): Promise<PublicationWork | null> {
    return await transaction(this.pool, async (client) => {
      const candidate = await client.query<{
        run_id: string
        status: PublicationStatus
      }>(
        `
        SELECT p.run_id, p.status
        FROM publications p
        JOIN executions e ON e.run_id=p.run_id AND e.connector_id=p.connector_id
        WHERE p.connector_id=$1
          AND e.status='succeeded' AND jsonb_typeof(e.workflow_result) <> 'null'
          AND NOT EXISTS (SELECT 1 FROM publication_steps s
            WHERE s.run_id=p.run_id AND s.connector_id=p.connector_id
              AND s.status='disconnected')
          AND (p.status='pending' OR
            (p.status IN ('publishing','uncertain')
              AND p.claimed_at <= clock_timestamp()-($2*interval '1 millisecond')))
        ORDER BY p.updated_at
        FOR UPDATE OF p SKIP LOCKED
        LIMIT 1
      `,
        [this.connectorId, this.claimTimeoutMs]
      )
      const candidateRow = candidate.rows[0]
      if (candidateRow === undefined) return null
      const runId = candidateRow.run_id
      const token = crypto.randomUUID()
      // Restate the FULL claimable condition instead of relying on the SELECT's row lock alone.
      // The lock makes this safe today; repeating the predicate keeps it safe if the two
      // statements are ever split, and it guarantees the UPDATE can only succeed on a row the
      // SELECT could legitimately have chosen. That matters for more than the status: a row
      // selected as an expired `publishing` lease must still be expired here, or a concurrent
      // claimant that just renewed it would have its healthy lease overwritten. `status=$4`
      // additionally pins the row the event's `from_status` was captured from, so the audit log
      // cannot claim an origin the row no longer had.
      //
      // The execution join is repeated for the same reason: it pins the exact set of columns the
      // SELECT filtered on, so if these statements are ever split (or the SELECT's predicate
      // drifts) the UPDATE alone still refuses a row whose execution is not successful with a
      // stored result. It is not a substitute for the SELECT's `FOR UPDATE` lock, which is what
      // serialises concurrent writers today.
      const claimed = await client.query(
        `
        UPDATE publications p SET status='publishing', claim_token=$3,
          claimed_at=clock_timestamp(),
          started_at=COALESCE(p.started_at, clock_timestamp()),
          failure_code=NULL, failure_message=NULL,
          updated_at=clock_timestamp()
        FROM executions e
        WHERE p.run_id=$1 AND p.connector_id=$2 AND p.status=$4
          AND e.run_id=p.run_id AND e.connector_id=p.connector_id
          AND e.status='succeeded' AND jsonb_typeof(e.workflow_result) <> 'null'
          AND NOT EXISTS (SELECT 1 FROM publication_steps s
            WHERE s.run_id=p.run_id AND s.connector_id=p.connector_id
              AND s.status='disconnected')
          AND (
            $4='pending'
            OR ($4 IN ('publishing','uncertain')
              AND p.claimed_at <= clock_timestamp()-($5*interval '1 millisecond'))
          )
      `,
        [
          runId,
          this.connectorId,
          token,
          candidateRow.status,
          this.claimTimeoutMs
        ]
      )
      if (claimed.rowCount !== 1)
        throw new Error(
          `Publication work changed while being claimed: ${runId}`
        )
      await appendEvent(client, {
        runId,
        connectorId: this.connectorId,
        axis: 'publication',
        fromStatus: candidateRow.status,
        toStatus: 'publishing',
        reasonCode:
          candidateRow.status === 'publishing' ||
          candidateRow.status === 'uncertain'
            ? 'PUBLICATION_LEASE_EXPIRED'
            : null
      })
      const result = await client.query<ReviewRunRow>(
        `${RUN_SELECT}
        WHERE r.run_id=$1 AND r.connector_id=$2`,
        [runId, this.connectorId]
      )
      const row = result.rows[0]
      if (row === undefined || row.execution.workflow_result === null)
        throw new Error(`Claimed publication work is incomplete: ${runId}`)
      return {
        ...rowToRecord(row),
        workflow_result: row.execution.workflow_result,
        claim_token: token
      }
    })
  }
  publicationHeartbeatIntervalMs(): number {
    return this.publications.heartbeatIntervalMs()
  }
  async renewPublicationClaim(runId: string, token: string): Promise<boolean> {
    return await this.publications.renewClaim(runId, token)
  }
  async initializePublicationSteps(
    runId: string,
    token: string,
    stepKeys: string[]
  ): Promise<void> {
    return await this.publications.initializePublicationSteps(
      runId,
      token,
      stepKeys
    )
  }
  async listPublicationSteps(runId: string): Promise<PublicationStepRecord[]> {
    return await this.publications.listPublicationSteps(runId)
  }
  async requirePublicationStepClaim(
    runId: string,
    token: string,
    stepKey: string
  ): Promise<void> {
    return await this.publications.requirePublicationStepClaim(
      runId,
      token,
      stepKey
    )
  }
  async completePublicationStep(
    runId: string,
    token: string,
    stepKey: string,
    remote: { id?: string | null; url?: string | null } = {}
  ): Promise<boolean> {
    return await this.publications.completePublicationStep(
      runId,
      token,
      stepKey,
      remote
    )
  }
  /** Conclude an exhausted step from what the connector found remotely; see the store. */
  async settleExhaustedPublicationStep(
    runId: string,
    token: string,
    stepKey: string,
    outcome:
      | { found: true; remote: { id?: string | null; url?: string | null } }
      | { found: false }
  ): Promise<boolean> {
    return await this.publications.settleExhaustedPublicationStep(
      runId,
      token,
      stepKey,
      outcome
    )
  }
  async failPublicationStep(
    runId: string,
    token: string,
    stepKey: string,
    error: { code?: string | null; message: string },
    options: { retry?: boolean } = {}
  ): Promise<boolean> {
    return await this.publications.failPublicationStep(
      runId,
      token,
      stepKey,
      error,
      options
    )
  }
  async completePublication(runId: string, token: string): Promise<boolean> {
    return await this.publications.complete(runId, token)
  }
  async failPublication(
    runId: string,
    token: string,
    error: { code?: string | null; message: string },
    options: { retry: boolean }
  ): Promise<boolean> {
    return await this.publications.fail(runId, token, error, options)
  }
  async failPreparation(
    runId: string,
    token: string,
    error: { code?: string | null; message: string },
    options: { retry: boolean; retryAfterMs?: number } = { retry: false }
  ): Promise<{ retry_scheduled: boolean }> {
    this.ready()
    return await this.preparations.fail(runId, token, error, options)
  }
  async close(): Promise<void> {
    await this.pool.end()
  }
}
