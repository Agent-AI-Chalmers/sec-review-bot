import assert from 'node:assert/strict'
import test from 'node:test'

import {
  coordinateReviewRunsOnce,
  startReviewRunCoordinatorLoop,
  type ReviewRunRecord,
  type RunRowsProjection
} from '../src/index.js'

const run: ReviewRunRecord = {
  run_id: 'run-1',
  workflow: 'issue-review',
  publish_context: {},
  preparation: {
    status: 'submitted',
    attempt_count: 1,
    started_at: '2026-01-01T00:00:01.000Z',
    finished_at: '2026-01-01T00:00:02.000Z',
    updated_at: '2026-01-01T00:00:03.000Z',
    failure_code: null,
    expiry_blocked_reason: null
  },
  execution: {
    status: 'queued',
    started_at: null,
    finished_at: null,
    updated_at: '2026-01-01T00:00:00.000Z'
  },
  publication: {
    status: 'pending',
    started_at: null,
    finished_at: null,
    updated_at: '2026-01-01T00:00:00.000Z'
  },
  created_at: '2026-01-01T00:00:00.000Z',
  failure_code: null,
  failure_message: null,
  artifact_storage: null,
  failure_notice: null
}

/** A pass result with nothing dropped, for the common stub case. */
function projected(runs: ReviewRunRecord[]): RunRowsProjection {
  return { runs, dropped: [] }
}

test('coordination expires preparations before recovery and active observation', async () => {
  const events: string[] = []
  const store = {
    async expireStalePreparations() {
      events.push('expire')
      return { concluded: 0, blocked: [] }
    },
    async listSubmissionRecoveries() {
      return projected([{ ...run, run_id: 'recover-1' }])
    },
    async listActiveRuns() {
      return projected([{ ...run, run_id: 'active-1' }])
    }
  }

  await coordinateReviewRunsOnce(store, {
    async recoverSubmission(entry) {
      events.push(`recover:${entry.run_id}`)
    },
    async readRunnerStatuses() {
      events.push('read')
      return { runs: [], missing: [], byRunId: new Map() }
    },
    async observeActiveRun(entry) {
      events.push(`observe:${entry.run_id}`)
    },
    onDroppedRunRow() {
      throw new Error('this pass drops no rows')
    },
    onBlockedPreparationExpiry() {
      throw new Error('this pass blocks no expiries')
    }
  })

  assert.deepStrictEqual(events, [
    'expire',
    'recover:recover-1',
    'read',
    'observe:active-1'
  ])
})

test('one pass reads every active run status in a single request', async () => {
  // The per-run shape made the request count grow with the number of runs in flight, so
  // the moments with the most runs were the ones that checked least often. A pass must
  // ask once, whatever the number of runs.
  const store = {
    async expireStalePreparations() {
      return { concluded: 0, blocked: [] }
    },
    async listSubmissionRecoveries() {
      return projected([])
    },
    async listActiveRuns() {
      return projected(
        [1, 2, 3].map((index) => ({ ...run, run_id: `active-${index}` }))
      )
    }
  }
  const reads: string[][] = []
  const observed: string[] = []

  await coordinateReviewRunsOnce(store, {
    async recoverSubmission() {
      throw new Error('this pass has nothing to recover')
    },
    async readRunnerStatuses(runs) {
      reads.push(runs.map((entry) => entry.run_id))
      return { runs: [], missing: [], byRunId: new Map() }
    },
    async observeActiveRun(entry) {
      observed.push(entry.run_id)
    },
    onDroppedRunRow() {
      throw new Error('this pass drops no rows')
    },
    onBlockedPreparationExpiry() {
      throw new Error('this pass blocks no expiries')
    }
  })

  assert.deepStrictEqual(reads, [['active-1', 'active-2', 'active-3']])
  assert.deepStrictEqual(observed, ['active-1', 'active-2', 'active-3'])
})

test('a pass with no active runs asks the Runner nothing', async () => {
  const reads: number[] = []
  const store = {
    async expireStalePreparations() {
      return { concluded: 0, blocked: [] }
    },
    async listSubmissionRecoveries() {
      return projected([])
    },
    async listActiveRuns() {
      return projected([])
    }
  }

  await coordinateReviewRunsOnce(store, {
    async recoverSubmission() {
      throw new Error('this pass has nothing to recover')
    },
    async readRunnerStatuses() {
      reads.push(1)
      return { runs: [], missing: [], byRunId: new Map() }
    },
    async observeActiveRun() {
      throw new Error('this pass has nothing to observe')
    },
    onDroppedRunRow() {
      throw new Error('this pass drops no rows')
    },
    onBlockedPreparationExpiry() {
      throw new Error('this pass blocks no expiries')
    }
  })

  assert.deepStrictEqual(reads, [])
})

test('a single row the contract cannot represent degrades that run, not the pass', async () => {
  // The reads are fan-outs, so a bad row would otherwise abort the whole result set and the
  // pass would observe nothing (ordered, sticky). Report the bad row and keep going: the
  // healthy runs on both sides of it are still observed.
  const store = {
    async expireStalePreparations() {
      return { concluded: 0, blocked: [] }
    },
    async listSubmissionRecoveries() {
      return {
        runs: [],
        dropped: [{ run_id: 'recover-bad', error: new Error('poison') }]
      }
    },
    async listActiveRuns() {
      return {
        runs: [
          { ...run, run_id: 'active-1' },
          { ...run, run_id: 'active-2' }
        ],
        dropped: [
          { run_id: 'active-bad', error: new Error('unrepresentable artifact') }
        ]
      }
    }
  }
  const observed: string[] = []
  const reported: Array<{ run_id: string; message: string }> = []

  await coordinateReviewRunsOnce(store, {
    async recoverSubmission() {},
    async readRunnerStatuses() {
      return { runs: [], missing: [], byRunId: new Map() }
    },
    async observeActiveRun(entry) {
      observed.push(entry.run_id)
    },
    onBlockedPreparationExpiry() {
      throw new Error('this pass blocks no expiries')
    },
    onDroppedRunRow({ run_id, error }) {
      reported.push({
        run_id,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  })

  assert.deepStrictEqual(
    observed,
    ['active-1', 'active-2'],
    'the healthy runs are still observed'
  )
  assert.deepStrictEqual(reported, [
    { run_id: 'recover-bad', message: 'poison' },
    { run_id: 'active-bad', message: 'unrepresentable artifact' }
  ])
})

test('coordinator loop does not overlap passes and stop drains the active pass', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let passes = 0
  const loop = startReviewRunCoordinatorLoop({
    intervalMs: 1,
    async runOnce() {
      passes += 1
      await gate
    },
    onError: (error) => {
      throw error
    }
  })

  await new Promise((resolve) => setTimeout(resolve, 10))
  const stopping = loop.stop()
  assert.strictEqual(passes, 1)
  release()
  await stopping
})
