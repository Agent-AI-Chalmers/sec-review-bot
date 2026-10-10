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
    async observeActiveRun(run) {
      events.push(`observe:${run.run_id}`)
    }
  })

  assert.deepEqual(events, ['expire', 'recover:recover-1', 'observe:active-1'])
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
