import assert from 'node:assert/strict'
import test from 'node:test'

import { BackgroundPreparations } from '../../src/reviews/background-preparations.js'

test('BackgroundPreparations waits for admitted preparation work during shutdown', async () => {
  const preparations = new BackgroundPreparations()
  let finish: (() => void) | undefined
  let stopped = false
  const preparation = new Promise<void>((resolve) => {
    finish = resolve
  })

  preparations.start(preparation)
  const stopping = preparations.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()

  assert.strictEqual(stopped, false)
  finish?.()
  await stopping
  assert.strictEqual(stopped, true)
})

test('BackgroundPreparations logs failures with ingress context', async () => {
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
  const preparations = new BackgroundPreparations((event, fields) =>
    logs.push({ event, fields })
  )

  preparations.start(Promise.reject(new Error('workspace failed')), {
    ingress: 'issues.opened',
    repo: 'octo/example'
  })
  await preparations.stop()

  assert.strictEqual(logs.length, 1)
  assert.strictEqual(logs[0]?.event, 'review_background_preparation_failed')
  assert.strictEqual(logs[0]?.fields.ingress, 'issues.opened')
  assert.strictEqual(logs[0]?.fields.repo, 'octo/example')
  assert.strictEqual(logs[0]?.fields.error_message, 'workspace failed')
})
