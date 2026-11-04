import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { channel } from 'node:diagnostics_channel'
import type { FastifyInstance } from 'fastify'
import { once } from 'node:events'
import test, { type TestContext } from 'node:test'

import { PostgresMemoryCatalogStore } from '../src/catalog-store.js'
process.env.NODE_ENV = 'test'
const { startMemoryCatalogServer } = await import('../src/server.js')

async function setup(t: TestContext) {
  const occupied = createServer()
  occupied.listen(0, '127.0.0.1')
  await once(occupied, 'listening')
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        occupied.listening
          ? occupied.close((error) => (error ? reject(error) : resolve()))
          : resolve(),
      ),
  )
  const address = occupied.address()
  assert(address && typeof address !== 'string')
  const environment: Record<string, string | undefined> = {
    MEMORY_CATALOG_DATABASE_URL: 'postgresql://unused',
    MEMORY_CATALOG_WORKER_TOKEN: 'worker',
    MEMORY_CATALOG_OPERATOR_TOKEN: 'operator',
    MEMORY_CATALOG_HOST: '127.0.0.1',
    MEMORY_CATALOG_PORT: String(address.port),
  }
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
  t.mock.method(PostgresMemoryCatalogStore.prototype, 'initialize', () => {
    opens += 1
    return Promise.resolve()
  })
  t.mock.method(PostgresMemoryCatalogStore.prototype, 'close', () => {
    closes += 1
    return closeFailure ? Promise.reject(closeFailure) : Promise.resolve()
  })
  return {
    occupied,
    opens: () => opens,
    closes: () => closes,
    failClose: (error: Error) => {
      closeFailure = error
    },
  }
}

await test('listen failure releases resources acquired during startup', async (t) => {
  const fixture = await setup(t)
  await assert.rejects(startMemoryCatalogServer(), { code: 'EADDRINUSE' })
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
  const running = await startMemoryCatalogServer()
  initialization.unsubscribe(installCloseFailure)
  await assert.rejects(running.close(), failure)
  assert.equal(fixture.closes(), 1)
  await running.close()
  assert.equal(fixture.closes(), 1)
})

await test('shutdown does not close the backend twice after a backend close error', async (t) => {
  const fixture = await setup(t)
  await new Promise<void>((resolve) => fixture.occupied.close(() => resolve()))
  const running = await startMemoryCatalogServer()
  const failure = new Error('backend close failed')
  fixture.failClose(failure)
  await assert.rejects(running.close(), failure)
  await running.close()
  assert.equal(fixture.closes(), 1)
})

await test('invalid configuration fails before opening backend resources', async (t) => {
  const fixture = await setup(t)
  delete process.env.MEMORY_CATALOG_WORKER_TOKEN
  await assert.rejects(
    startMemoryCatalogServer(),
    /MEMORY_CATALOG_WORKER_TOKEN/,
  )
  assert.equal(fixture.opens(), 0)
})

await test('startup retains the original failure when backend cleanup also fails', async (t) => {
  const fixture = await setup(t)
  const failure = new Error('backend cleanup failed')
  fixture.failClose(failure)
  await assert.rejects(startMemoryCatalogServer(), (error: unknown) => {
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
  t.mock.method(PostgresMemoryCatalogStore.prototype, 'initialize', () =>
    Promise.reject(failure),
  )
  await assert.rejects(startMemoryCatalogServer(), failure)
  assert.equal(fixture.closes(), 1)
})
