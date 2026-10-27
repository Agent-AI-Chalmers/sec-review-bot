import { aggregateExecutionStatistics } from './execution-statistics.js'
import type {
  ExecutionStatisticsStore,
  ExecutionStatisticsWork
} from './execution-statistics-store.js'
import { LangfuseRateLimitError } from './langfuse-observations-client.js'
import type { LangfuseObservationsClient } from './langfuse-observations-client.js'

const OBSERVATION_TIME_MARGIN_MS = 5 * 60 * 1000

type StatisticsStore = Pick<
  ExecutionStatisticsStore,
  'claimNext' | 'recordSnapshot' | 'recordFailure' | 'recordRateLimit'
>

type ObservationsReader = Pick<LangfuseObservationsClient, 'readRun'>

interface ReconciliationOptions {
  store: StatisticsStore
  langfuse: ObservationsReader
  confirmationDelayMs: number
  maxFailures: number
  retryDelayMs: number
  onResult: (
    work: ExecutionStatisticsWork,
    result:
      | 'pending'
      | 'settled'
      | 'partial_window'
      | 'no_observations'
      | 'unavailable'
  ) => void
  onError: (work: ExecutionStatisticsWork, error: unknown) => void
}

async function reconcileClaimedWork(
  work: ExecutionStatisticsWork,
  {
    store,
    langfuse,
    confirmationDelayMs,
    maxFailures,
    retryDelayMs,
    onResult,
    onError
  }: ReconciliationOptions
): Promise<void> {
  let snapshot
  try {
    const read = await langfuse.readRun({
      runId: work.runId,
      fromStartTime: new Date(
        Date.parse(work.executionStartedAt) - OBSERVATION_TIME_MARGIN_MS
      ).toISOString(),
      toStartTime: new Date(
        Date.parse(work.executionFinishedAt) + OBSERVATION_TIME_MARGIN_MS
      ).toISOString()
    })
    snapshot = aggregateExecutionStatistics(read)
  } catch (error) {
    if (error instanceof LangfuseRateLimitError) {
      const result = await store.recordRateLimit(
        work,
        error.retryAfterMs ?? retryDelayMs
      )
      onResult(work, result)
      return
    }
    onError(work, error)
    const result = await store.recordFailure(work, maxFailures, retryDelayMs)
    if (result === 'unavailable') onResult(work, result)
    return
  }
  // Persistence failures are local coordination failures, not evidence that Langfuse is down.
  // Let the outer loop report them and leave the fenced claim for normal stale-claim recovery.
  const result = await store.recordSnapshot(work, snapshot, confirmationDelayMs)
  onResult(work, result)
}

/** Reconcile a bounded batch so a backlog cannot age past its settlement window.
 *
 * The bound prevents one busy pass from monopolizing shutdown or Langfuse. Returning the number
 * processed also makes the drain behavior directly testable without exposing claim internals. */
export async function reconcileExecutionStatisticsPass({
  maxItems,
  store,
  langfuse,
  confirmationDelayMs,
  maxFailures,
  retryDelayMs,
  onResult,
  onError
}: ReconciliationOptions & { maxItems: number }): Promise<number> {
  let processed = 0
  while (processed < maxItems) {
    const work = await store.claimNext()
    if (work === null) break
    await reconcileClaimedWork(work, {
      store,
      langfuse,
      confirmationDelayMs,
      maxFailures,
      retryDelayMs,
      onResult,
      onError
    })
    processed += 1
  }
  return processed
}
