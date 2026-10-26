import assert from 'node:assert/strict'
import test from 'node:test'

import { RefreshQueue } from '../browser/shared/refresh-queue.js'

function controlledPromise(): {
  promise: Promise<void>
  resolve: () => void
  reject: (reason?: unknown) => void
} {
  let resolve!: () => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

test('concurrent refresh requests merge into one queued attempt', async () => {
  const first = controlledPromise()
  const second = controlledPromise()
  const attempts = [first, second]
  let runs = 0
  const queue = new RefreshQueue(() => attempts[runs++].promise)

  const active = queue.request()
  const queuedA = queue.request()
  const queuedB = queue.request()
  assert.equal(runs, 1)

  first.resolve()
  await active
  assert.equal(runs, 2)

  let queuedSettled = false
  void Promise.all([queuedA, queuedB]).then(() => {
    queuedSettled = true
  })
  await Promise.resolve()
  assert.equal(queuedSettled, false)

  second.resolve()
  await Promise.all([queuedA, queuedB])
  assert.equal(runs, 2)
})

test('requests arriving during the queued attempt append only one further attempt', async () => {
  const gates = [controlledPromise(), controlledPromise(), controlledPromise()]
  let runs = 0
  const queue = new RefreshQueue(() => gates[runs++].promise)

  const first = queue.request()
  const second = queue.request()
  gates[0].resolve()
  await first
  assert.equal(runs, 2)

  const third = queue.request()
  const fourth = queue.request()
  gates[1].resolve()
  await second
  assert.equal(runs, 3)

  let trailingSettled = false
  void Promise.all([third, fourth]).then(() => {
    trailingSettled = true
  })
  await Promise.resolve()
  assert.equal(trailingSettled, false)

  gates[2].resolve()
  await Promise.all([third, fourth])
  assert.equal(runs, 3)
})

test('a rejected attempt settles its waiters and continues the trailing batch', async () => {
  const first = controlledPromise()
  const second = controlledPromise()
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

  assert.equal(runs, 2)
  assert.equal(settledAttempts, 1)
  assert.deepEqual(runningChanges, [true])
  let trailingSettled = false
  void trailing.then(() => {
    trailingSettled = true
  })
  await Promise.resolve()
  assert.equal(trailingSettled, false)

  second.resolve()
  await trailing
  assert.equal(settledAttempts, 2)
  assert.deepEqual(runningChanges, [true, false])
})

test('a throwing start notification cannot block the attempt or later requests', async () => {
  const gates = [controlledPromise(), controlledPromise()]
  let runs = 0
  const queue = new RefreshQueue(
    () => gates[runs++].promise,
    (running) => {
      if (running) throw new Error('controlled start notification failure')
    }
  )

  const first = queue.request()
  assert.equal(runs, 1)
  gates[0].resolve()
  await first

  const second = queue.request()
  assert.equal(runs, 2)
  gates[1].resolve()
  await second
})

test('a throwing settled notification cannot strand waiters or stop the queue', async () => {
  const gates = [controlledPromise(), controlledPromise()]
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
  assert.equal(runs, 2)
  gates[1].resolve()
  await second
})

test('a throwing end notification leaves the queue ready for another request', async () => {
  const gates = [controlledPromise(), controlledPromise()]
  let runs = 0
  const queue = new RefreshQueue(
    () => gates[runs++].promise,
    (running) => {
      if (!running) throw new Error('controlled end notification failure')
    }
  )

  const first = queue.request()
  gates[0].resolve()
  await first

  const second = queue.request()
  assert.equal(runs, 2)
  gates[1].resolve()
  await second
})
