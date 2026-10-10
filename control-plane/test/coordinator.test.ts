import assert from 'node:assert/strict'
import test from 'node:test'

import { coordinateReviewRunsOnce, startReviewRunCoordinatorLoop } from '../src/index.js'

const run = {
  run_id: 'run-1',
  workflow: 'issue-review' as const,
  publish_context: {},
  status: 'queued' as const,
  runner_status: 'queued' as const,
  publication_status: 'pending' as const,
  created_at: '2026-01-01T00:00:00.000Z',
  execution_updated_at: '2026-01-01T00:00:00.000Z',
  publication_updated_at: '2026-01-01T00:00:00.000Z',
  published_at: null,
  failure_code: null,
  failure_message: null,
  artifact_storage: null
}

test('coordination expires preparations before recovery and active observation', async () => {
  const events: string[] = []
  const store = {
    async expireStalePreparations() {
      events.push('expire')
      return 0
    },
    async listSubmissionRecoveries() {
      return [{ ...run, run_id: 'recover-1' }]
    },
    async listActiveRuns() {
      return [{ ...run, run_id: 'active-1' }]
    }
  }

  await coordinateReviewRunsOnce(store, {
    async recoverSubmission(run) {
      events.push(`recover:${run.run_id}`)
    },
    async readRunnerStatuses() {
      events.push('read')
      return { runs: [], missing: [], byRunId: new Map() }
    },
    async observeActiveRun(run) {
      events.push(`observe:${run.run_id}`)
    }
  })

  assert.deepEqual(events, ['expire', 'recover:recover-1', 'read', 'observe:active-1'])
})

test('one pass reads every active run status in a single request', async () => {
  // The per-run shape made the request count grow with the number of runs in flight, so
  // the moments with the most runs were the ones that checked least often. A pass must
  // ask once, whatever the number of runs.
  const store = {
    async expireStalePreparations() {
      return 0
    },
    async listSubmissionRecoveries() {
      return []
    },
    async listActiveRuns() {
      return [1, 2, 3].map((index) => ({ ...run, run_id: `active-${index}` }))
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
    }
  })

  assert.deepEqual(reads, [['active-1', 'active-2', 'active-3']])
  assert.deepEqual(observed, ['active-1', 'active-2', 'active-3'])
})

test('a pass with no active runs asks the Runner nothing', async () => {
  const reads: number[] = []
  const store = {
    async expireStalePreparations() {
      return 0
    },
    async listSubmissionRecoveries() {
      return []
    },
    async listActiveRuns() {
      return []
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
    }
  })

  assert.deepEqual(reads, [])
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
  assert.equal(passes, 1)
  release()
  await stopping
})
