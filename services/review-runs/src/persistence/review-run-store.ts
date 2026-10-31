// Implements Review Runs's durable review trunk and orchestrates cross-axis transitions that
// must move more than one lifecycle axis in one transaction. Read-model queries live in
// `review-run-queries.ts`; SQL row projection lives in `run-record-projection.ts`; and
// submission and operator-only cross-axis decisions live in their concrete transition stores.
//
// Axis ownership:
// - `execution-store.ts` owns single-axis execution writes (status transitions, observation
//   heartbeat, artifact/result, submission-recovery claims).
// - `preparation-store.ts` / `publication-store.ts` own their own axes.
// - `run-notices.ts` owns notification delivery and transaction-aware enqueue/supersession.
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
import { normalizeArtifactStorage, type ReviewRunRecord } from '../shapes.js'
import { PreparationStore } from './preparation-store.js'
import { PublicationStore } from './publication-store.js'
import { PublicationClaimStore } from './publication-claim-store.js'
import { abandonInFlightPublication } from './publication-abandon.js'
import { appendEvent } from './review-run-events.js'
import { OperatorDecisionStore } from './operator-decision-store.js'
import { ReviewRunAdmissionStore } from './review-run-admission-store.js'
import { ReviewRunQueries, type DroppedRunRow } from './review-run-queries.js'
import { queueRunNotice, RunNoticeStore } from './run-notices.js'
import { ExecutionStore } from './execution-store.js'
import { InputBundleCandidateStore } from './input-bundle-candidate-store.js'
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

const DEFAULT_CLAIM_TIMEOUT_MS = 10 * 60 * 1000

export type {
  PreparationExpiryBlocked,
  PreparationExpiryResult,
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
  readonly notices: RunNoticeStore
  readonly preparations: PreparationStore
  readonly publications: PublicationStore
  readonly publicationClaims: PublicationClaimStore
  readonly executions: ExecutionStore
  readonly operatorDecisions: OperatorDecisionStore
  readonly admissions: ReviewRunAdmissionStore
  readonly queries: ReviewRunQueries
  readonly inputBundleCandidates: InputBundleCandidateStore
  readonly submissionTransitions: SubmissionTransitionStore

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
    this.notices = new RunNoticeStore(
      this.database,
      this.connectorId,
      this.claimTimeoutMs
    )
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
    this.inputBundleCandidates = new InputBundleCandidateStore(
      this.database,
      this.connectorId,
      this.claimTimeoutMs
    )
    this.submissionTransitions = new SubmissionTransitionStore(
      this.database,
      this.connectorId,
      this.claimTimeoutMs
    )
  }

  async initialize(): Promise<void> {
    await this.database.initialize()
  }

  /** Verify the dependency boundary required to accept coordination requests. */
  async checkReadiness(): Promise<void> {
    await this.database.checkLedger()
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
  async close(): Promise<void> {
    await this.database.close()
  }
}
