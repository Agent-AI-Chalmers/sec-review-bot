// Implements Review Runs's durable review trunk and orchestrates cross-axis transitions that
// must move more than one lifecycle axis in one transaction. Read-model queries live in
// `review-run-queries.ts`; SQL row projection lives in `run-record-projection.ts`; and
// submission and operator-only cross-axis decisions live in their concrete transition stores.
//
// Axis ownership:
// - `execution-store.ts` owns single-axis execution writes (status transitions, observation
//   heartbeat, artifact/result, submission-recovery claims).
// - `preparation-store.ts` / `publication-store.ts` own their own axes.
// - This store owns the run trunk, composes the concrete stores, and retains the terminal
//   execution-failure transition that skips publication. Submission transitions live in
//   `submission-transition-store.ts`; preparations initiating an execution skip stay in the
//   preparation store.
// - `publication-abandon.ts` holds the one transition shared by more than one axis: concluding a
//   publication that can never publish. It is separate because both preparation and execution
//   trigger it, and single-axis stores must not import each other (this store is what constructs
//   them). It is still a cross-axis write, kept atomic by taking the caller's transaction.
//
// Publication has no reversion into it: an uncertain submission leaves publication `pending`
// rather than skipping it, so neither an accepted nor a rejected replay has a publication
// transition to undo.
// Each concrete store fences its writes with the claim token for the axis it owns.
import { Pool } from 'pg'

import { Database } from '../database/database.js'

import type { ExecutionArtifactStorage } from '../contracts.js'
import { transaction } from '../database/transaction.js'
import {
  normalizeArtifactStorage,
  type CreateReviewRunArgs,
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
import { PublicationClaimStore } from './publication-claim-store.js'
import { abandonInFlightPublication } from './publication-abandon.js'
import { appendEvent } from './review-run-events.js'
import { OperatorDecisionStore } from './operator-decision-store.js'
import { ReviewRunAdmissionStore } from './review-run-admission-store.js'
import {
  ReviewRunQueries,
  type DroppedRunRow,
  type ListRunsOptions,
  type ParkedRun,
  type RunRowsProjection
} from './review-run-queries.js'
import { queueRunNotice } from './run-notices.js'
import { ExecutionStore } from './execution-store.js'
import { SubmissionTransitionStore } from './submission-transition-store.js'

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
  private readonly database: Database
  readonly connectorId: string
  readonly sourcePlatform: ReviewRunRecord['source_platform']
  private readonly claimTimeoutMs: number
  private readonly preparations: PreparationStore
  private readonly publications: PublicationStore
  private readonly publicationClaims: PublicationClaimStore
  private readonly executions: ExecutionStore
  private readonly operatorDecisions: OperatorDecisionStore
  private readonly admissions: ReviewRunAdmissionStore
  private readonly queries: ReviewRunQueries
  private readonly submissionTransitions: SubmissionTransitionStore

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
    this.database = new Database({
      ...(connectionString === undefined ? {} : { connectionString }),
      ...(pool === undefined ? {} : { pool })
    })
    this.connectorId = connectorId
    this.sourcePlatform = sourcePlatform
    this.claimTimeoutMs = Math.max(0, claimTimeoutMs)
    this.preparations = new PreparationStore(
      this.database,
      this.connectorId,
      this.claimTimeoutMs
    )
    this.publications = new PublicationStore(
      this.database,
      this.connectorId,
      this.claimTimeoutMs
    )
    this.publicationClaims = new PublicationClaimStore(
      this.database,
      this.connectorId,
      this.claimTimeoutMs
    )
    this.executions = new ExecutionStore(
      this.database,
      this.connectorId,
      this.claimTimeoutMs
    )
    this.operatorDecisions = new OperatorDecisionStore(
      this.database,
      this.connectorId,
      this.publications,
      this.executions
    )
    this.admissions = new ReviewRunAdmissionStore(
      this.database,
      this.connectorId,
      this.sourcePlatform
    )
    this.queries = new ReviewRunQueries(
      this.database,
      this.connectorId,
      this.claimTimeoutMs,
      onDroppedRunRow
    )
    this.submissionTransitions = new SubmissionTransitionStore(
      this.database,
      this.connectorId
    )
  }

  async initialize(): Promise<void> {
    await this.database.initialize()
  }

  /** Verify the dependency boundary required to accept coordination requests. */
  async checkReadiness(): Promise<void> {
    await this.database.checkLedger()
  }

  async createPreparingReviewRun(
    run: CreateReviewRunArgs
  ): Promise<ReviewRunAdmission> {
    return await this.admissions.create(run)
  }
  async admitReviewRun(
    run: CreateReviewRunArgs &
      Required<Pick<CreateReviewRunArgs, 'ingress_kind' | 'ingress_key'>>
  ): Promise<ReviewRunAdmission> {
    return await this.admissions.admit(run)
  }
  async savePreparedSubmission(
    runId: string,
    token: string,
    context: PublishContext,
    input: JsonObject
  ): Promise<void> {
    await this.submissionTransitions.savePreparedSubmission(
      runId,
      token,
      context,
      input
    )
  }
  async renewPreparationClaim(runId: string, token: string): Promise<boolean> {
    return await this.preparations.renewClaim(runId, token)
  }
  async claimNextPreparation(): Promise<PreparationWork | null> {
    return await this.preparations.claimNext()
  }
  async checkpointPreparationInput(
    runId: string,
    token: string,
    input: JsonObject
  ): Promise<void> {
    await this.preparations.checkpointInput(runId, token, input)
  }
  async claimNextRunNotice(): Promise<RunNoticeWork | null> {
    return await this.preparations.claimNextRunNotice()
  }
  async completeRunNotice(
    noticeId: string,
    token: string,
    delivered: boolean,
    commentUrl?: string | null
  ): Promise<boolean> {
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
    await this.submissionTransitions.markQueued(runId, token, context)
  }
  async runExists(runId: string): Promise<boolean> {
    return await this.queries.runExists(runId)
  }
  async listEvents(runId: string): Promise<ReviewRunEvent[]> {
    return await this.queries.listEvents(runId)
  }
  async getRun(runId: string): Promise<ReviewRunRecord | null> {
    return await this.queries.getRun(runId)
  }
  async getExecutionStatistics(
    runIds: readonly string[]
  ): Promise<Map<string, ExecutionStatisticsSummary>> {
    return await this.queries.getExecutionStatistics(runIds)
  }
  async listRunsPage(options: ListRunsOptions = {}): Promise<{
    runs: ReviewRunRecord[]
    next_cursor: string | null
    dropped: DroppedRunRow[]
  }> {
    return await this.queries.listRunsPage(options)
  }
  async expireStalePreparations(): Promise<PreparationExpiryResult> {
    return await this.preparations.expireStale()
  }
  async listParkedRuns(): Promise<ParkedRun[]> {
    return await this.queries.listParkedRuns()
  }

  async abandonBlockedPreparation(
    runId: string,
    reason: string
  ): Promise<ReviewRunRecord> {
    return await this.operatorDecisions.abandonBlockedPreparation(runId, reason)
  }

  async resumeDisconnectedRun(runId: string): Promise<ReviewRunRecord> {
    return await this.operatorDecisions.resumeDisconnectedRun(runId)
  }

  async resumeDisconnectedPublication(runId: string): Promise<ReviewRunRecord> {
    return await this.operatorDecisions.resumeDisconnectedPublication(runId)
  }

  async giveUpDisconnectedRun(
    runId: string,
    reason: string
  ): Promise<ReviewRunRecord> {
    return await this.operatorDecisions.giveUpDisconnectedRun(runId, reason)
  }

  async resumeDisconnectedExecution(runId: string): Promise<ReviewRunRecord> {
    return await this.operatorDecisions.resumeDisconnectedExecution(runId)
  }

  async resumeDisconnectedPreparation(runId: string): Promise<ReviewRunRecord> {
    return await this.operatorDecisions.resumeDisconnectedPreparation(runId)
  }

  async listSubmissionRecoveries(): Promise<RunRowsProjection> {
    return await this.queries.listSubmissionRecoveries()
  }
  async claimSubmissionRecovery(runId: string): Promise<string | null> {
    return await this.executions.claimSubmissionRecovery(runId)
  }
  /** How many replays of an uncertain submission ended with the outcome still unknown. */
  async submissionRecoveryAttemptCount(runId: string): Promise<number | null> {
    const result = await this.database.pool().query<{ attempt_count: number }>(
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
    return await this.submissionTransitions.completeSubmissionRecovery(
      runId,
      token
    )
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
    return await this.submissionTransitions.failSubmissionRecovery(
      runId,
      token,
      error
    )
  }
  /** Active (queued/running) runs for this connector, as a projection: a row the contract
   * cannot represent is returned in `dropped` instead of aborting the read for every run. */
  async listActiveRuns(): Promise<RunRowsProjection> {
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
    return await transaction(this.database.pool(), async (client) => {
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
  async claimPublication(runId: string): Promise<string | null> {
    return await this.publicationClaims.claim(runId)
  }
  async claimNextPublication(waitMs = 0): Promise<PublicationWork | null> {
    return await this.publicationClaims.claimNext(waitMs)
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
    return await this.preparations.fail(runId, token, error, options)
  }
  async close(): Promise<void> {
    await this.database.close()
  }
}
