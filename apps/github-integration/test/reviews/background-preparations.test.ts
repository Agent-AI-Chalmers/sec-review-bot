import assert from 'node:assert/strict'
import test from 'node:test'

import { BackgroundPreparations } from '../../src/reviews/background-preparations.js'

test('BackgroundPreparations waits for admitted preparation work during shutdown', async () => {
  const preparations = new BackgroundPreparations()
  let finish: (() => void) | undefined
  let stopped = false
  const execution = new Promise<void>((resolve) => {
    finish = resolve
  })

  preparations.start(execution)
  const stopping = preparations.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()

  assert.equal(stopped, false)
  finish?.()
  await stopping
  assert.equal(stopped, true)
})

test('BackgroundPreparations logs failures with ingress context', async () => {
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
  const preparations = new BackgroundPreparations((event, fields) => logs.push({ event, fields }))

  preparations.start(Promise.reject(new Error('workspace failed')), {
    ingress: 'issues.opened',
    repo: 'octo/example'
  })
  await preparations.stop()

  assert.equal(logs.length, 1)
  assert.equal(logs[0]?.event, 'review_background_execution_failed')
  assert.equal(logs[0]?.fields.ingress, 'issues.opened')
  assert.equal(logs[0]?.fields.repo, 'octo/example')
  assert.equal(logs[0]?.fields.error_message, 'workspace failed')
})
