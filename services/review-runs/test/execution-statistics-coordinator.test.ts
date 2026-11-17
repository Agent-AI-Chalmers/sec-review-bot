import { expect, test } from 'vitest'

import { reconcileExecutionStatisticsPass } from '../src/statistics/execution-statistics-coordinator.js'
import type { ExecutionStatisticsWork } from '../src/statistics/execution-statistics-store.js'
import { LangfuseRateLimitError } from '../src/statistics/langfuse-observations-client.js'

function work(index: number): ExecutionStatisticsWork {
  return {
    runId: `run-${index}`,
    claimToken: `claim-${index}`,
    executionStartedAt: '2026-01-01T00:00:00.000Z',
    executionFinishedAt: '2026-01-01T00:01:00.000Z'
  }
}

const emptyRead = {
  roots: [],
  generations: [],
  excludedNonReviewRootCount: 0
}

test('a statistics pass drains several due runs up to its bound', async () => {
  const queue = [work(1), work(2), work(3)]
  const recorded: string[] = []
  const processed = await reconcileExecutionStatisticsPass({
    maxItems: 2,
    store: {
      async claimNext() {
        return queue.shift() ?? null
      },
      async recordSnapshot(item) {
        recorded.push(item.runId)
        return 'settled'
      },
      async recordFailure() {
        throw new Error('this pass has no failed reads')
      },
      async recordRateLimit() {
        throw new Error('this pass was not rate limited')
      }
    },
    langfuse: {
      async readRun() {
        return emptyRead
      }
    },
    confirmationDelayMs: 0,
    maxConsecutiveFailures: 3,
    retryDelayMs: 0,
    onResult() {},
    onError() {
      throw new Error('this pass has no read errors')
    }
  })

  expect(processed).toBe(2)
  expect(recorded).toStrictEqual(['run-1', 'run-2'])
  expect(queue.map((item) => item.runId)).toStrictEqual(['run-3'])
})

test('a persistence failure does not spend the Langfuse failure budget', async () => {
  let failureRecorded = false
  await expect(
    reconcileExecutionStatisticsPass({
      maxItems: 1,
      store: {
        async claimNext() {
          return work(1)
        },
        async recordSnapshot() {
          throw new Error('database unavailable')
        },
        async recordFailure() {
          failureRecorded = true
          return 'pending'
        },
        async recordRateLimit() {
          throw new Error('this pass was not rate limited')
        }
      },
      langfuse: {
        async readRun() {
          return emptyRead
        }
      },
      confirmationDelayMs: 0,
      maxConsecutiveFailures: 3,
      retryDelayMs: 0,
      onResult() {},
      onError() {
        throw new Error('Langfuse succeeded, so this must not run')
      }
    })
  ).rejects.toThrow(/database unavailable/)
  expect(failureRecorded).toBe(false)
})

test('rate limiting defers work without spending the failure budget', async () => {
  let deferredFor: number | null = null
  let failureRecorded = false
  const results: string[] = []
  const processed = await reconcileExecutionStatisticsPass({
    maxItems: 1,
    store: {
      async claimNext() {
        return work(1)
      },
      async recordSnapshot() {
        throw new Error('a rate-limited read has no snapshot')
      },
      async recordFailure() {
        failureRecorded = true
        return 'pending'
      },
      async recordRateLimit(_item, retryDelayMs) {
        deferredFor = retryDelayMs
        return 'pending'
      }
    },
    langfuse: {
      async readRun() {
        throw new LangfuseRateLimitError(12_000)
      }
    },
    confirmationDelayMs: 0,
    maxConsecutiveFailures: 3,
    retryDelayMs: 1_000,
    onResult(_item, result) {
      results.push(result)
    },
    onError() {
      throw new Error('rate limiting is provider backpressure, not an outage')
    }
  })

  expect(processed).toBe(1)
  expect(deferredFor).toBe(12_000)
  expect(failureRecorded).toBe(false)
  expect(results).toStrictEqual(['pending'])
})

test('rate limiting reports unavailable once the settlement window is exhausted', async () => {
  const results: string[] = []
  await reconcileExecutionStatisticsPass({
    maxItems: 1,
    store: {
      async claimNext() {
        return work(1)
      },
      async recordSnapshot() {
        throw new Error('a rate-limited read has no snapshot')
      },
      async recordFailure() {
        throw new Error('rate limiting does not spend the failure budget')
      },
      async recordRateLimit() {
        return 'unavailable'
      }
    },
    langfuse: {
      async readRun() {
        throw new LangfuseRateLimitError(12_000)
      }
    },
    confirmationDelayMs: 0,
    maxConsecutiveFailures: 3,
    retryDelayMs: 1_000,
    onResult(_item, result) {
      results.push(result)
    },
    onError() {
      throw new Error('rate limiting is an expected provider response')
    }
  })

  expect(results).toStrictEqual(['unavailable'])
})
