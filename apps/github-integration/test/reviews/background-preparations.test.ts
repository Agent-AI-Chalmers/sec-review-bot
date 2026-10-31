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

test('admission releases the handler while shutdown still waits for preparation', async () => {
  const preparations = new BackgroundPreparations()
  let admit: (() => void) | undefined
  let finish: (() => void) | undefined
  let acknowledged = false
  let stopped = false
  const work = new Promise<void>((resolve) => {
    finish = resolve
  })
  const acknowledgement = preparations
    .startAndWaitForAdmission((on_admitted) => {
      admit = on_admitted
      return work
    })
    .then(() => {
      acknowledged = true
    })
  // Shutdown starts before the command's microtask has run: it must already
  // include that command, not just work whose admission callback has fired.
  const stopping = preparations.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  assert.equal(acknowledged, false)
  assert.equal(stopped, false)
  assert.ok(admit)
  admit()
  await acknowledgement
  assert.equal(acknowledged, true)
  assert.equal(stopped, false)
  assert.ok(finish)
  finish()
  await stopping
  assert.equal(stopped, true)
})

test('failure before admission rejects the handler and records its ingress context', async () => {
  const logs: Record<string, unknown>[] = []
  const preparations = new BackgroundPreparations((_event, fields) => {
    logs.push(fields)
  })
  const error = new Error('admission unavailable')
  await assert.rejects(
    preparations.startAndWaitForAdmission(
      async () => {
        throw error
      },
      { ingress: 'issues.opened' }
    ),
    error
  )
  await preparations.stop()
  assert.equal(logs.length, 1)
  assert.equal(logs[0]?.error, error)
  assert.equal(logs[0]?.ingress, 'issues.opened')
})

test('failure after admission stays owned by the background tracker', async () => {
  const logs: Record<string, unknown>[] = []
  const preparations = new BackgroundPreparations((_event, fields) => {
    logs.push(fields)
  })
  const error = new Error('preparation failed')
  let fail: ((error: Error) => void) | undefined
  const work = new Promise<void>((_resolve, reject) => {
    fail = reject
  })
  await preparations.startAndWaitForAdmission(
    (on_admitted) => {
      on_admitted()
      return work
    },
    { repo: 'octo/example' }
  )
  assert.equal(logs.length, 0)
  assert.ok(fail)
  fail(error)
  await preparations.stop()
  assert.equal(logs.length, 1)
  assert.equal(logs[0]?.error, error)
  assert.equal(logs[0]?.repo, 'octo/example')
})

test('command completion without an admission notification also releases the handler', async () => {
  const preparations = new BackgroundPreparations()
  await preparations.startAndWaitForAdmission(async () => ({
    run_id: 'replayed'
  }))
  await preparations.stop()
})

test('a synchronous command error is tracked and rejects the handler', async () => {
  const logs: Record<string, unknown>[] = []
  const preparations = new BackgroundPreparations((_event, fields) => {
    logs.push(fields)
  })
  const error = new Error('synchronous start failure')
  await assert.rejects(
    preparations.startAndWaitForAdmission(() => {
      throw error
    }),
    error
  )
  await preparations.stop()
  assert.equal(logs.length, 1)
  assert.equal(logs[0]?.error, error)
})
