import { setTimeout as delay } from 'node:timers/promises'

import {
  runMemoryChineseFlow,
  runMemoryOverviewFlow,
  runMemoryRevisionFlow,
  runMemoryFilesFlow,
  runMemoryTrajectoryFlow,
  runMemoryEditFlow,
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

test.describe('local memory fixtures', () => {
  test.beforeEach(async ({ page, fixtureRuntime }) => {
    test.skip(
      fixtureRuntime.server === undefined,
      'These checks require isolated local memory fixtures.'
    )
    await page.addInitScript(() =>
      localStorage.setItem('ui-auto-refresh', 'false')
    )
    await openAuthenticatedRuns(page)
  })

  test('Chinese memory wording and observation layout', async ({
    page,
    fixtureRuntime
  }, testInfo) => {
    await runMemoryChineseFlow({
      page,
      base: fixtureRuntime.baseURL,
      name: testInfo.project.name
    })
  })

  test('memory overview ranges reload only the overview', async ({
    page
  }, testInfo) => {
    await runMemoryOverviewFlow({
      page,
      name: testInfo.project.name,
      waitUntil
    })
  })

  test('memory revision graph and list layout', async ({ page }, testInfo) => {
    await runMemoryRevisionFlow({
      page,
      name: testInfo.project.name,
      viewport: page.viewportSize(),
      screenshotPath: testInfo.outputPath('memory-revisions.png')
    })
  })

  test('memory files and revision diff viewers', async ({
    page,
    context,
    fixtureRuntime
  }, testInfo) => {
    await runMemoryFilesFlow({
      page,
      context,
      base: fixtureRuntime.baseURL,
      name: testInfo.project.name,
      viewport: page.viewportSize()
    })
  })

  test('memory trajectories and observation navigation', async ({
    page
  }, testInfo) => {
    await runMemoryTrajectoryFlow({
      page,
      name: testInfo.project.name,
      viewport: page.viewportSize(),
      waitUntil
    })
  })

  test('memory restore and edit retry preserve revision identity', async ({
    page
  }, testInfo) => {
    await runMemoryEditFlow({
      page,
      name: testInfo.project.name,
      viewport: page.viewportSize(),
      waitUntil
    })
  })
})
