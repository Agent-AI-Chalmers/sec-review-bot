import { expect, test } from 'vitest'

import { RefreshQueue } from '../browser/shared/refresh-queue.js'

test('concurrent refresh requests merge into one queued attempt', async () => {
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  const attempts = [first, second]
  let runs = 0
  const queue = new RefreshQueue(() => attempts[runs++].promise)

  const active = queue.request()
  const queuedA = queue.request()
  const queuedB = queue.request()
  expect(runs).toBe(1)

  first.resolve()
  await active
  expect(runs).toBe(2)

  let queuedSettled = false
  void Promise.all([queuedA, queuedB]).then(() => {
    queuedSettled = true
  })
  await Promise.resolve()
  expect(queuedSettled).toBe(false)

  second.resolve()
  await Promise.all([queuedA, queuedB])
  expect(runs).toBe(2)
})

test('requests arriving during the queued attempt append only one further attempt', async () => {
  const gates = [
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>()
  ]
  let runs = 0
  const queue = new RefreshQueue(() => gates[runs++].promise)

  const first = queue.request()
  const second = queue.request()
  gates[0].resolve()
  await first
  expect(runs).toBe(2)

  const third = queue.request()
  const fourth = queue.request()
  gates[1].resolve()
  await second
  expect(runs).toBe(3)

  let trailingSettled = false
  void Promise.all([third, fourth]).then(() => {
    trailingSettled = true
  })
  await Promise.resolve()
  expect(trailingSettled).toBe(false)

  gates[2].resolve()
  await Promise.all([third, fourth])
  expect(runs).toBe(3)
})

test('a rejected attempt settles its waiters and continues the trailing batch', async () => {
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  const attempts = [first, second]
  const runningChanges: boolean[] = []
  let runs = 0
  let settledAttempts = 0
  const queue = new RefreshQueue(
    () => attempts[runs++].promise,
    (running) => runningChanges.push(running),
    () => {
      settledAttempts += 1
    }
  )

  const active = queue.request()
  const trailing = queue.request()
  first.reject(new Error('controlled refresh failure'))
  await active

  expect(runs).toBe(2)
  expect(settledAttempts).toBe(1)
  expect(runningChanges).toStrictEqual([true])
  let trailingSettled = false
  void trailing.then(() => {
    trailingSettled = true
  })
  await Promise.resolve()
  expect(trailingSettled).toBe(false)

  second.resolve()
  await trailing
  expect(settledAttempts).toBe(2)
  expect(runningChanges).toStrictEqual([true, false])
})

test('a throwing start notification cannot block the attempt or later requests', async () => {
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  let runs = 0
  const queue = new RefreshQueue(
    () => gates[runs++].promise,
    (running) => {
      if (running) {
        throw new Error('controlled start notification failure')
      }
    }
  )

  const first = queue.request()
  expect(runs).toBe(1)
  gates[0].resolve()
  await first

  const second = queue.request()
  expect(runs).toBe(2)
  gates[1].resolve()
  await second
})

test('a throwing settled notification cannot strand waiters or stop the queue', async () => {
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  let runs = 0
  const queue = new RefreshQueue(
    () => gates[runs++].promise,
    undefined,
    () => {
      throw new Error('controlled settled notification failure')
    }
  )

  const first = queue.request()
  gates[0].resolve()
  await first

  const second = queue.request()
  expect(runs).toBe(2)
  gates[1].resolve()
  await second
})

test('a throwing end notification leaves the queue ready for another request', async () => {
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  let runs = 0
  const queue = new RefreshQueue(
    () => gates[runs++].promise,
    (running) => {
      if (!running) {
        throw new Error('controlled end notification failure')
      }
    }
  )

  const first = queue.request()
  gates[0].resolve()
  await first

  const second = queue.request()
  expect(runs).toBe(2)
  gates[1].resolve()
  await second
})
