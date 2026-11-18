import { createServer } from 'node:http'
import { channel } from 'node:diagnostics_channel'
import type { FastifyInstance } from 'fastify'
import { once } from 'node:events'
import { expect, vi, test, type TestContext } from 'vitest'

import { TemporalExecutionClient } from '../src/temporal-execution-client.js'
process.env.NODE_ENV = 'test'
const { startExecutionGateway } = await import('../src/server.js')

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
    EXECUTION_GATEWAY_TOKEN: 'test-token',
    EXECUTION_GATEWAY_HOST: '127.0.0.1',
    EXECUTION_GATEWAY_PORT: String(address.port)
  }
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
  vi.spyOn(TemporalExecutionClient, 'connect').mockImplementation(() => {
    opens += 1
    return Promise.resolve({
      close: () => {
        closes += 1
        return closeFailure ? Promise.reject(closeFailure) : Promise.resolve()
      }
    } as TemporalExecutionClient)
  })
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
  await expect(startExecutionGateway()).rejects.toMatchObject({
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
  const running = await startExecutionGateway()
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
  const running = await startExecutionGateway()
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
  process.env.EXECUTION_GATEWAY_HOST = '0.0.0.0'
  delete process.env.EXECUTION_GATEWAY_TOKEN
  await expect(startExecutionGateway()).rejects.toThrow(/EXECUTION_GATEWAY_TOKEN/)
  expect(fixture.opens()).toBe(0)
})

test('startup retains the original failure when backend cleanup also fails', async (t) => {
  const fixture = await setup(t)
  const failure = new Error('backend cleanup failed')
  fixture.failClose(failure)
  await expect(startExecutionGateway()).rejects.toSatisfy((error: unknown) => {
    expect.assert(error instanceof SuppressedError)
    expect(error.error).toBe(failure)
    const original: unknown = error.suppressed
    expect.assert(original instanceof Error && 'code' in original)
    expect(original.code).toBe('EADDRINUSE')
    return true
  })
  expect(fixture.closes()).toBe(1)
})
