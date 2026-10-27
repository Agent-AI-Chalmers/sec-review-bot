// Composes the Review Runs process: durable stores, background coordinators, and HTTP surface.
import Fastify from 'fastify'

import type { ReviewRunWorkflow } from '../contracts.js'
import {
  coordinateReviewRunsOnce,
  startReviewRunCoordinatorLoop
} from './coordinator.js'
import { integerEnv } from '../env.js'
import {
  ExecutionSubmissionUncertainError,
  getExecutionRunStatus,
  getExecutionRunStatuses,
  isTerminalExecutionPollingError,
  submitExecutionRun,
  type ExecutionRunStatus,
  type ExecutionRunStatusBatch
} from '../execution-client.js'
import { ReviewRunStore } from '../persistence/review-store.js'
import { reconcileExecutionStatisticsPass } from '../statistics/execution-statistics-coordinator.js'
import { ExecutionStatisticsStore } from '../statistics/execution-statistics-store.js'
import { SUBMISSION_STATE_UNCERTAIN } from '../errors.js'
import { LangfuseObservationsClient } from '../statistics/langfuse-observations-client.js'
import {
  REVIEW_RUNS_FASTIFY_OPTIONS,
  registerReviewRunsRoutes
} from '../http/server-surface.js'
import {
  concludeExhaustedSubmissionRecovery,
  recoverReviewRunSubmission
} from './submission-recovery.js'
import { observeExecutionRun } from './terminal-coordination.js'

const STATUSES_NEEDING_RUN_RECORD = new Set(['succeeded', 'failed'])

function executionStatusFromBatch(
  batch: ExecutionRunStatusBatch
): (runId: string, workflow: ReviewRunWorkflow) => Promise<ExecutionRunStatus> {
  return async (runId, workflow) => {
    const status = batch.byRunId.get(runId)
    if (status !== undefined && !STATUSES_NEEDING_RUN_RECORD.has(status)) {
      return { run_id: runId, workflow, status }
    }
    return await getExecutionRunStatus(runId, workflow)
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function langfuseConfiguration(): {
  baseUrl: string
  publicKey: string
  secretKey: string
} | null {
  const values = {
    baseUrl: process.env.LANGFUSE_BASE_URL?.trim() || undefined,
    publicKey: process.env.LANGFUSE_PUBLIC_KEY?.trim() || undefined,
    secretKey: process.env.LANGFUSE_SECRET_KEY?.trim() || undefined
  }
  const configured = Object.values(values).filter(
    (value): value is string => value !== undefined
  )
  if (configured.length === 0) return null
  if (configured.length !== 3)
    throw new Error(
      'LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY, and LANGFUSE_SECRET_KEY must be configured together.'
    )
  return values as { baseUrl: string; publicKey: string; secretKey: string }
}

function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ event, ...fields }))
}

function logDroppedRunRow(
  connectorId: string,
  dropped: { run_id: string; error: unknown }
): void {
  logEvent('review_runs_run_row_dropped', {
    connector_id: connectorId,
    run_id: dropped.run_id,
    error:
      dropped.error instanceof Error
        ? dropped.error.message
        : String(dropped.error)
  })
}

function logParkedRun(
  connectorId: string,
  blocked: { run_id: string; reason: string }
): void {
  logEvent('review_runs_preparation_expiry_blocked', {
    connector_id: connectorId,
    run_id: blocked.run_id,
    reason: blocked.reason
  })
}

export async function startReviewRunsServer(): Promise<{
  close: () => Promise<void>
}> {
  const intervalMs = integerEnv(
    'AGENT_EXECUTION_BACKGROUND_POLL_INTERVAL_MS',
    15_000
  )
  const port = integerEnv('REVIEW_RUNS_PORT', 8090, 1, 65_535)
  const token = requiredEnv('REVIEW_RUNS_SERVICE_TOKEN')
  const readToken = requiredEnv('REVIEW_RUNS_READ_TOKEN')
  const adminToken = process.env.REVIEW_RUNS_ADMIN_TOKEN?.trim() || undefined
  const connectorId =
    process.env.CONNECTOR_ID?.trim() || 'github-integration:default'
  const connectionString = requiredEnv('DATABASE_URL')
  const store = new ReviewRunStore({
    connectionString,
    connectorId,
    onDroppedRunRow: (dropped) => logDroppedRunRow(connectorId, dropped)
  })
  await store.initialize()

  const coordinator = startReviewRunCoordinatorLoop({
    intervalMs,
    runOnce: async () =>
      await coordinateReviewRunsOnce(store, {
        recoverSubmission: async (run) => {
          logEvent('execution_submission_recovery_started', {
            connector_id: store.connectorId,
            run_id: run.run_id,
            workflow: run.workflow
          })
          const exhausted = await concludeExhaustedSubmissionRecovery(
            store,
            run
          )
          if (exhausted !== null) {
            logEvent('execution_submission_recovery_disconnected', {
              connector_id: store.connectorId,
              run_id: run.run_id,
              workflow: run.workflow
            })
            return
          }
          await recoverReviewRunSubmission(store, run, {
            submit: submitExecutionRun,
            classifyError: (error) => ({
              uncertain: error instanceof ExecutionSubmissionUncertainError,
              code:
                error instanceof ExecutionSubmissionUncertainError
                  ? SUBMISSION_STATE_UNCERTAIN
                  : error instanceof Error &&
                      'code' in error &&
                      typeof error.code === 'string'
                    ? error.code
                    : 'REVIEW_START_FAILED',
              message: error instanceof Error ? error.message : String(error)
            })
          })
          logEvent('execution_submission_recovery_completed', {
            connector_id: store.connectorId,
            run_id: run.run_id,
            workflow: run.workflow
          })
        },
        readExecutionStatuses: (runs) =>
          getExecutionRunStatuses(runs.map((run) => run.run_id)),
        onDroppedRunRow: (dropped) => {
          logDroppedRunRow(store.connectorId, dropped)
        },
        onBlockedPreparationExpiry: (blocked) => {
          logParkedRun(store.connectorId, blocked)
        },
        observeActiveRun: async (run, statuses) => {
          await observeExecutionRun(
            store,
            run,
            executionStatusFromBatch(statuses),
            isTerminalExecutionPollingError,
            (event) => {
              console.info(
                JSON.stringify({
                  event: event.kind,
                  connector_id: store.connectorId,
                  ...event
                })
              )
            }
          )
        }
      }),
    onError: (error) => {
      console.error('review_runs_execution_coordination_failed', error)
    }
  })

  const langfuseConfig = langfuseConfiguration()
  const statisticsStore =
    langfuseConfig === null
      ? null
      : new ExecutionStatisticsStore({
          connectionString,
          connectorId,
          claimTimeoutMs: integerEnv(
            'EXECUTION_STATISTICS_CLAIM_TIMEOUT_MS',
            10 * 60_000
          ),
          initialDelayMs: integerEnv(
            'EXECUTION_STATISTICS_INITIAL_DELAY_MS',
            30_000,
            0
          ),
          settlementWindowMs: integerEnv(
            'EXECUTION_STATISTICS_SETTLEMENT_WINDOW_MS',
            10 * 60_000
          )
        })
  const statisticsCoordinator =
    statisticsStore === null || langfuseConfig === null
      ? null
      : startReviewRunCoordinatorLoop({
          intervalMs: integerEnv(
            'EXECUTION_STATISTICS_POLL_INTERVAL_MS',
            15_000
          ),
          runOnce: async () => {
            await reconcileExecutionStatisticsPass({
              maxItems: integerEnv(
                'EXECUTION_STATISTICS_MAX_ITEMS_PER_PASS',
                20
              ),
              store: statisticsStore,
              langfuse: new LangfuseObservationsClient(
                langfuseConfig.baseUrl,
                langfuseConfig.publicKey,
                langfuseConfig.secretKey,
                integerEnv('LANGFUSE_REQUEST_TIMEOUT_MS', 30_000)
              ),
              confirmationDelayMs: integerEnv(
                'EXECUTION_STATISTICS_CONFIRMATION_DELAY_MS',
                30_000
              ),
              maxFailures: integerEnv('EXECUTION_STATISTICS_MAX_FAILURES', 8),
              retryDelayMs: integerEnv(
                'EXECUTION_STATISTICS_RETRY_DELAY_MS',
                30_000
              ),
              onResult: (work, result) => {
                logEvent('execution_statistics_reconciled', {
                  connector_id: store.connectorId,
                  run_id: work.runId,
                  result
                })
              },
              onError: (work, error) => {
                console.error(
                  'execution_statistics_langfuse_read_failed',
                  work.runId,
                  error instanceof Error ? error.message : String(error)
                )
              }
            })
          },
          onError: (error) => {
            console.error('execution_statistics_coordination_failed', error)
          }
        })

  const app = Fastify(REVIEW_RUNS_FASTIFY_OPTIONS)
  await registerReviewRunsRoutes(app, {
    store,
    serviceToken: token,
    readToken,
    ...(adminToken === undefined ? {} : { adminToken })
  })
  await app.listen({ port, host: '0.0.0.0' })

  return {
    close: async () => {
      await app.close()
      await coordinator.stop()
      if (statisticsCoordinator !== null) await statisticsCoordinator.stop()
      if (statisticsStore !== null) await statisticsStore.close()
      await store.close()
    }
  }
}
