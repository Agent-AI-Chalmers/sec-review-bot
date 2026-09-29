import assert from 'node:assert/strict'
import test from 'node:test'

import { ReviewExecutionTracker } from '../../infrastructure/review-execution-tracker.js'

test('ReviewExecutionTracker waits for admitted preparation work during shutdown', async () => {
  const tracker = new ReviewExecutionTracker()
  let finish: (() => void) | undefined
  let stopped = false
  const execution = new Promise<void>((resolve) => { finish = resolve })

  tracker.start(execution)
  const stopping = tracker.stop().then(() => { stopped = true })
  await Promise.resolve()

  assert.equal(stopped, false)
  finish?.()
  await stopping
  assert.equal(stopped, true)
})

test('ReviewExecutionTracker logs background failures with ingress context', async () => {
  const logs: Array<{ event: string, fields: Record<string, unknown> }> = []
  const tracker = new ReviewExecutionTracker((event, fields) => logs.push({ event, fields }))

  tracker.start(Promise.reject(new Error('workspace failed')), {
    ingress: 'issues.opened',
    repo: 'octo/example'
  })
  await tracker.stop()

  assert.equal(logs.length, 1)
  assert.equal(logs[0]?.event, 'review_background_execution_failed')
  assert.equal(logs[0]?.fields.ingress, 'issues.opened')
  assert.equal(logs[0]?.fields.repo, 'octo/example')
  assert.equal(logs[0]?.fields.error_message, 'workspace failed')
})
