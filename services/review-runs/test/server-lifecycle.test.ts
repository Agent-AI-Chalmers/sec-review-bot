import { createServer } from 'node:http'
import { channel } from 'node:diagnostics_channel'
import type { FastifyInstance } from 'fastify'
import { once } from 'node:events'
import { expect, vi, test, type TestContext } from 'vitest'

import { ExecutionStatisticsStore } from '../src/statistics/execution-statistics-store.js'
import { PreparationStore } from '../src/persistence/preparation-store.js'
import { ReviewRunQueries } from '../src/persistence/review-run-queries.js'
import { ReviewRunStore } from '../src/persistence/review-run-store.js'
process.env.NODE_ENV = 'test'
const { startReviewRunsServer } = await import('../src/runtime/server-runtime.js')

async function setup(t: TestContext) {
  const occupied = createServer()
  occupied.listen(0, '127.0.0.1')
  await once(occupied, 'listening')
  t.onTestFinished(
    () =>
      new Promise<void>((resolve, reject) =>
        occupied.listening
          ? occupied.close((error) => (error ? reject(error) : resolve()))
          : resolve()
      )
  )
  const address = occupied.address()
  expect.assert(address && typeof address !== 'string')
  const environment: Record<string, string | undefined> = {
    DATABASE_URL: 'postgresql://unused',
    REVIEW_RUNS_SERVICE_TOKEN: 'service',
    REVIEW_RUNS_READ_TOKEN: 'read',
    REVIEW_RUNS_PORT: String(address.port)
  }
  for (const name of ['LANGFUSE_BASE_URL', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'])
    environment[name] = undefined
  for (const [name, value] of Object.entries(environment)) {
    const previous = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    t.onTestFinished(() => {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    })
  }
  let opens = 0
  let closes = 0
  let closeFailure: Error | undefined
  vi.spyOn(ReviewRunStore.prototype, 'initialize').mockImplementation(async () => {
    opens += 1
  })
  vi.spyOn(ReviewRunStore.prototype, 'close').mockImplementation(() => {
    closes += 1
    return closeFailure ? Promise.reject(closeFailure) : Promise.resolve()
  })
  vi.spyOn(ReviewRunStore.prototype, 'checkReadiness').mockImplementation(async () => {})
  vi.spyOn(PreparationStore.prototype, 'expireStale').mockImplementation(async () => ({
    blocked: [],
    concluded: 0
  }))
  vi.spyOn(ReviewRunQueries.prototype, 'listSubmissionRecoveries').mockImplementation(async () => ({
    runs: [],
    dropped: []
  }))
  vi.spyOn(ReviewRunQueries.prototype, 'listActiveRuns').mockImplementation(async () => ({
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

test('listen failure releases resources acquired during startup', async (t) => {
  const fixture = await setup(t)
  await expect(startReviewRunsServer()).rejects.toMatchObject({
    code: 'EADDRINUSE'
  })
  expect(fixture.closes()).toBe(1)
})

test('shutdown releases the backend even when HTTP close fails', async (t) => {
  const fixture = await setup(t)
  await new Promise<void>((resolve) => fixture.occupied.close(() => resolve()))
  const failure = new Error('HTTP close failed')
  const initialization = channel('fastify.initialization')
  const installCloseFailure = (message: unknown): void => {
    const { fastify } = message as { fastify: FastifyInstance }
    fastify.addHook('onClose', () => Promise.reject(failure))
  }
  initialization.subscribe(installCloseFailure)
  t.onTestFinished(() => initialization.unsubscribe(installCloseFailure))
  const running = await startReviewRunsServer()
  initialization.unsubscribe(installCloseFailure)
  await expect(running.close()).rejects.toMatchObject({
    ...failure,
    name: failure.name,
    message: failure.message
  })
  expect(fixture.closes()).toBe(1)
  await running.close()
  expect(fixture.closes()).toBe(1)
})

test('shutdown does not close the backend twice after a backend close error', async (t) => {
  const fixture = await setup(t)
  await new Promise<void>((resolve) => fixture.occupied.close(() => resolve()))
  const running = await startReviewRunsServer()
  const failure = new Error('backend close failed')
  fixture.failClose(failure)
  await expect(running.close()).rejects.toMatchObject({
    ...failure,
    name: failure.name,
    message: failure.message
  })
  await running.close()
  expect(fixture.closes()).toBe(1)
})

test('invalid configuration fails before opening backend resources', async (t) => {
  const fixture = await setup(t)
  process.env.LANGFUSE_BASE_URL = 'http://127.0.0.1:1'
  await expect(startReviewRunsServer()).rejects.toThrow(/must be configured together/)
  expect(fixture.opens()).toBe(0)
})

test('startup retains the original failure when backend cleanup also fails', async (t) => {
  const fixture = await setup(t)
  const failure = new Error('backend cleanup failed')
  fixture.failClose(failure)
  await expect(startReviewRunsServer()).rejects.toSatisfy((error: unknown) => {
    expect.assert(error instanceof SuppressedError)
    expect(error.error).toBe(failure)
    const original: unknown = error.suppressed
    expect.assert(original instanceof Error && 'code' in original)
    expect(original.code).toBe('EADDRINUSE')
    return true
  })
  expect(fixture.closes()).toBe(1)
})

test('initialization failure releases the partially initialized backend', async (t) => {
  const fixture = await setup(t)
  const failure = new Error('schema initialization failed')
  vi.spyOn(ReviewRunStore.prototype, 'initialize').mockImplementation(async () => {
    throw failure
  })
  await expect(startReviewRunsServer()).rejects.toMatchObject({
    ...failure,
    name: failure.name,
    message: failure.message
  })
  expect(fixture.closes()).toBe(1)
})

test('statistics cleanup failure still stops both background loops and closes the run store', async (t) => {
  const fixture = await setup(t)
  await new Promise<void>((resolve) => fixture.occupied.close(() => resolve()))
  process.env.LANGFUSE_BASE_URL = 'http://127.0.0.1:1'
  process.env.LANGFUSE_PUBLIC_KEY = 'test-public'
  process.env.LANGFUSE_SECRET_KEY = 'test-secret'
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  t.onTestFinished(() => {
    vi.useRealTimers()
  })
  let coordinationPasses = 0
  let statisticsPasses = 0
  vi.spyOn(PreparationStore.prototype, 'expireStale').mockImplementation(async () => {
    coordinationPasses += 1
    return { blocked: [], concluded: 0 }
  })
  vi.spyOn(ExecutionStatisticsStore.prototype, 'claimNext').mockImplementation(async () => {
    statisticsPasses += 1
    return null
  })
  const failure = new Error('statistics connection close failed')
  vi.spyOn(ExecutionStatisticsStore.prototype, 'close').mockImplementation(() =>
    Promise.reject(failure)
  )
  const running = await startReviewRunsServer()
  await expect(running.close()).rejects.toMatchObject({
    ...failure,
    name: failure.name,
    message: failure.message
  })
  expect(fixture.closes()).toBe(1)
  const stoppedAt = [coordinationPasses, statisticsPasses]
  vi.advanceTimersByTime(30_000)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect([coordinationPasses, statisticsPasses]).toStrictEqual(stoppedAt)
})
