import { setTimeout as delay } from 'node:timers/promises'

import {
  runMemoryFlow,
  runMemoryPreflightFlow
} from '../browser-flows/memory.mjs'
import { openAuthenticatedRuns, test } from './fixtures.ts'

async function waitUntil(
  predicate,
  message,
  { timeoutMs = 5_000, intervalMs = 50 } = {}
) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(message)
    await delay(intervalMs)
  }
}

test('memory request races and partial failures', async ({
  page,
  context,
  fixtureRuntime
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')
  await openAuthenticatedRuns(page)
  await runMemoryPreflightFlow({
    name: testInfo.project.name,
    context,
    base: fixtureRuntime.baseURL,
    server: fixtureRuntime.server
  })
})

test('memory browser behavior', async ({
  page,
  context,
  browser,
  fixtureRuntime
}, testInfo) => {
  await openAuthenticatedRuns(page)
  await runMemoryFlow({
    name: testInfo.project.name,
    viewport: page.viewportSize(),
    page,
    context,
    browser,
    base: fixtureRuntime.baseURL,
    server: fixtureRuntime.server,
    waitUntil
  })
})
