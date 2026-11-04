import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { channel } from 'node:diagnostics_channel'
import type { FastifyInstance } from 'fastify'
import { once } from 'node:events'
import test, { type TestContext } from 'node:test'

import { ExecutionStatisticsStore } from '../src/statistics/execution-statistics-store.js'
import { PreparationStore } from '../src/persistence/preparation-store.js'
import { ReviewRunQueries } from '../src/persistence/review-run-queries.js'
import { ReviewRunStore } from '../src/persistence/review-run-store.js'
process.env.NODE_ENV = 'test'
const { startReviewRunsServer } =
  await import('../src/runtime/server-runtime.js')

async function setup(t: TestContext) {
  const occupied = createServer()
  occupied.listen(0, '127.0.0.1')
  await once(occupied, 'listening')
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        occupied.listening
          ? occupied.close((error) => (error ? reject(error) : resolve()))
          : resolve()
      )
  )
  const address = occupied.address()
  assert(address && typeof address !== 'string')
  const environment: Record<string, string | undefined> = {
    DATABASE_URL: 'postgresql://unused',
    REVIEW_RUNS_SERVICE_TOKEN: 'service',
    REVIEW_RUNS_READ_TOKEN: 'read',
    REVIEW_RUNS_PORT: String(address.port)
  }
  for (const name of [
    'LANGFUSE_BASE_URL',
    'LANGFUSE_PUBLIC_KEY',
    'LANGFUSE_SECRET_KEY'
  ])
    environment[name] = undefined
  for (const [name, value] of Object.entries(environment)) {
    const previous = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    t.after(() => {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    })
  }
  let opens = 0
  let closes = 0
  let closeFailure: Error | undefined
  t.mock.method(ReviewRunStore.prototype, 'initialize', async () => {
    opens += 1
  })
  t.mock.method(ReviewRunStore.prototype, 'close', () => {
    closes += 1
    return closeFailure ? Promise.reject(closeFailure) : Promise.resolve()
  })
  t.mock.method(ReviewRunStore.prototype, 'checkReadiness', async () => {})
  t.mock.method(PreparationStore.prototype, 'expireStale', async () => ({
    blocked: []
  }))
  t.mock.method(
    ReviewRunQueries.prototype,
    'listSubmissionRecoveries',
    async () => ({ runs: [], dropped: [] })
  )
  t.mock.method(ReviewRunQueries.prototype, 'listActiveRuns', async () => ({
    runs: [],
    dropped: []
  }))
  return {
    occupied,
    opens: () => opens,
    closes: () => closes,
    failClose: (error: Error) => {
      closeFailure = error
    }
  }
}

await test('listen failure releases resources acquired during startup', async (t) => {
  const fixture = await setup(t)
  await assert.rejects(startReviewRunsServer(), { code: 'EADDRINUSE' })
  assert.equal(fixture.closes(), 1)
})

await test('shutdown releases the backend even when HTTP close fails', async (t) => {
  const fixture = await setup(t)
  await new Promise<void>((resolve) => fixture.occupied.close(() => resolve()))
  const failure = new Error('HTTP close failed')
  const initialization = channel('fastify.initialization')
  const installCloseFailure = (message: unknown): void => {
    const { fastify } = message as { fastify: FastifyInstance }
    fastify.addHook('onClose', () => Promise.reject(failure))
  }
  initialization.subscribe(installCloseFailure)
  t.after(() => initialization.unsubscribe(installCloseFailure))
  const running = await startReviewRunsServer()
  initialization.unsubscribe(installCloseFailure)
  await assert.rejects(running.close(), failure)
  assert.equal(fixture.closes(), 1)
  await running.close()
  assert.equal(fixture.closes(), 1)
})

await test('shutdown does not close the backend twice after a backend close error', async (t) => {
  const fixture = await setup(t)
  await new Promise<void>((resolve) => fixture.occupied.close(() => resolve()))
  const running = await startReviewRunsServer()
  const failure = new Error('backend close failed')
  fixture.failClose(failure)
  await assert.rejects(running.close(), failure)
  await running.close()
  assert.equal(fixture.closes(), 1)
})

await test('invalid configuration fails before opening backend resources', async (t) => {
  const fixture = await setup(t)
  process.env.LANGFUSE_BASE_URL = 'http://127.0.0.1:1'
  await assert.rejects(startReviewRunsServer(), /must be configured together/)
  assert.equal(fixture.opens(), 0)
})

await test('startup retains the original failure when backend cleanup also fails', async (t) => {
  const fixture = await setup(t)
  const failure = new Error('backend cleanup failed')
  fixture.failClose(failure)
  await assert.rejects(startReviewRunsServer(), (error: unknown) => {
    assert(error instanceof SuppressedError)
    assert.equal(error.error, failure)
    const original: unknown = error.suppressed
    assert(original instanceof Error && 'code' in original)
    assert.equal(original.code, 'EADDRINUSE')
    return true
  })
  assert.equal(fixture.closes(), 1)
})

await test('initialization failure releases the partially initialized backend', async (t) => {
  const fixture = await setup(t)
  const failure = new Error('schema initialization failed')
  t.mock.method(ReviewRunStore.prototype, 'initialize', async () => {
    throw failure
  })
  await assert.rejects(startReviewRunsServer(), failure)
  assert.equal(fixture.closes(), 1)
})

await test('statistics cleanup failure still stops both background loops and closes the run store', async (t) => {
  const fixture = await setup(t)
  await new Promise<void>((resolve) => fixture.occupied.close(() => resolve()))
  process.env.LANGFUSE_BASE_URL = 'http://127.0.0.1:1'
  process.env.LANGFUSE_PUBLIC_KEY = 'test-public'
  process.env.LANGFUSE_SECRET_KEY = 'test-secret'
  t.mock.timers.enable({ apis: ['setInterval'] })
  let coordinationPasses = 0
  let statisticsPasses = 0
  t.mock.method(PreparationStore.prototype, 'expireStale', async () => {
    coordinationPasses += 1
    return { blocked: [] }
  })
  t.mock.method(ExecutionStatisticsStore.prototype, 'claimNext', async () => {
    statisticsPasses += 1
    return null
  })
  const failure = new Error('statistics connection close failed')
  t.mock.method(ExecutionStatisticsStore.prototype, 'close', () =>
    Promise.reject(failure)
  )
  const running = await startReviewRunsServer()
  await assert.rejects(running.close(), failure)
  assert.equal(fixture.closes(), 1)
  const stoppedAt = [coordinationPasses, statisticsPasses]
  t.mock.timers.tick(30_000)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual([coordinationPasses, statisticsPasses], stoppedAt)
})
