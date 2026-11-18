import { expect, test } from 'vitest'

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

  expect(stopped).toBe(false)
  finish?.()
  await stopping
  expect(stopped).toBe(true)
})

test('BackgroundPreparations logs failures with ingress context', async () => {
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
  const preparations = new BackgroundPreparations((event, fields) => logs.push({ event, fields }))

  preparations.start(Promise.reject(new Error('workspace failed')), {
    ingress: 'issues.opened',
    repo: 'octo/example'
  })
  await preparations.stop()

  expect(logs).toHaveLength(1)
  expect(logs[0]?.event).toBe('review_background_preparation_failed')
  expect(logs[0]?.fields.ingress).toBe('issues.opened')
  expect(logs[0]?.fields.repo).toBe('octo/example')
  expect(logs[0]?.fields.error_message).toBe('workspace failed')
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
  expect(acknowledged).toBe(false)
  expect(stopped).toBe(false)
  expect.assert(admit)
  admit()
  await acknowledgement
  expect(acknowledged).toBe(true)
  expect(stopped).toBe(false)
  expect.assert(finish)
  finish()
  await stopping
  expect(stopped).toBe(true)
})

test('failure before admission rejects the handler and records its ingress context', async () => {
  const logs: Record<string, unknown>[] = []
  const preparations = new BackgroundPreparations((_event, fields) => {
    logs.push(fields)
  })
  const error = new Error('admission unavailable')
  await expect(
    preparations.startAndWaitForAdmission(
      async () => {
        throw error
      },
      { ingress: 'issues.opened' }
    )
  ).rejects.toMatchObject({
    ...error,
    name: error.name,
    message: error.message
  })
  await preparations.stop()
  expect(logs).toHaveLength(1)
  expect(logs[0]?.error).toBe(error)
  expect(logs[0]?.ingress).toBe('issues.opened')
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
  expect(logs).toHaveLength(0)
  expect.assert(fail)
  fail(error)
  await preparations.stop()
  expect(logs).toHaveLength(1)
  expect(logs[0]?.error).toBe(error)
  expect(logs[0]?.repo).toBe('octo/example')
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
  await expect(
    preparations.startAndWaitForAdmission(() => {
      throw error
    })
  ).rejects.toMatchObject({
    ...error,
    name: error.name,
    message: error.message
  })
  await preparations.stop()
  expect(logs).toHaveLength(1)
  expect(logs[0]?.error).toBe(error)
})
