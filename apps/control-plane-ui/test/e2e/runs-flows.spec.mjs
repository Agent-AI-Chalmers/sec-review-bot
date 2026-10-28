import { setTimeout as delay } from 'node:timers/promises'

import {
  runRunsChineseCheck,
  runRunsClockCheck,
  runRunsInputAndThemeChecks
} from '../browser-flows/runs-environments.mjs'
import {
  runFixtureAdminFlow,
  runRunsErrorFlow
} from '../browser-flows/runs-errors.mjs'
import { runFixtureRunDeliveryFlow } from '../browser-flows/runs-fixture-delivery.mjs'
import { runFixtureRunListFlow } from '../browser-flows/runs-fixture-list.mjs'
import { runFixtureRunStatisticsFlow } from '../browser-flows/runs-fixture-statistics.mjs'
import { runRunsTimelineFlow } from '../browser-flows/runs-timeline.mjs'
import { runRunsFlow } from '../browser-flows/runs.mjs'
import { openAuthenticatedRuns, test } from './fixtures.ts'

const EXPECTED_HEADERS = [
  'Run',
  'Workflow',
  'Platform',
  'Preparation',
  'Execution',
  'Publication',
  'Last activity',
  'Failure code'
]

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

async function waitUntilValue(
  produce,
  predicate,
  message,
  { timeoutMs = 5_000, intervalMs = 50 } = {}
) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await produce()
    if (predicate(value)) return value
    if (Date.now() > deadline) throw new Error(message)
    await delay(intervalMs)
  }
}

async function runFilesError(page, baseURL) {
  await page.goto(`${baseURL}/runs/fixture-artifact-load-error/files`, {
    waitUntil: 'domcontentloaded'
  })
  await page
    .getByText('The run files could not be opened.', { exact: true })
    .waitFor()
  await page.getByRole('link', { name: 'Download diagnostic bundle' }).waitFor()
}

async function skipEmptyExternalRuns(page, fixtureRuntime) {
  if (fixtureRuntime.server !== undefined) return
  test.skip(
    (await page.locator('tbody tr').count()) === 0,
    'The external deployment currently has no runs to inspect.'
  )
}

test('runs browser behavior', async ({ page, fixtureRuntime }, testInfo) => {
  await openAuthenticatedRuns(page)

  const hasRuns = await runRunsFlow({
    name: testInfo.project.name,
    viewport: page.viewportSize(),
    page,
    base: fixtureRuntime.baseURL,
    server: fixtureRuntime.server,
    waitUntil,
    expectedHeaders: EXPECTED_HEADERS
  })
  test.skip(
    !hasRuns,
    'The external deployment currently has no runs to inspect.'
  )
})

test('fixture run list covers pagination, filters and identity navigation', async ({
  page,
  fixtureRuntime
}, testInfo) => {
  test.skip(
    fixtureRuntime.server === undefined,
    'Fixture-specific list and detail cases are not run against an external deployment.'
  )
  await openAuthenticatedRuns(page)
  await runFixtureRunListFlow({
    name: testInfo.project.name,
    page,
    base: fixtureRuntime.baseURL,
    waitUntil
  })
})

test('fixture run detail explains statistics and transitions', async ({
  page,
  fixtureRuntime
}, testInfo) => {
  test.skip(
    fixtureRuntime.server === undefined,
    'Fixture-specific list and detail cases are not run against an external deployment.'
  )
  await openAuthenticatedRuns(page)
  await runFixtureRunStatisticsFlow({
    name: testInfo.project.name,
    viewport: page.viewportSize(),
    page,
    base: fixtureRuntime.baseURL,
    waitUntil
  })
})

test('fixture run detail presents artifacts and delivery', async ({
  page,
  fixtureRuntime
}, testInfo) => {
  test.skip(
    fixtureRuntime.server === undefined,
    'Fixture-specific list and detail cases are not run against an external deployment.'
  )
  await openAuthenticatedRuns(page)
  await runFixtureRunDeliveryFlow({
    name: testInfo.project.name,
    viewport: page.viewportSize(),
    page,
    base: fixtureRuntime.baseURL,
    waitUntil
  })
  await runFilesError(page, fixtureRuntime.baseURL)
})

test('runs remain usable with touch input and both themes', async ({
  page,
  browser,
  fixtureRuntime
}, testInfo) => {
  await openAuthenticatedRuns(page)
  await skipEmptyExternalRuns(page, fixtureRuntime)
  await runRunsInputAndThemeChecks({
    name: testInfo.project.name,
    viewport: page.viewportSize(),
    browser,
    base: fixtureRuntime.baseURL,
    storageState: await page.context().storageState(),
    waitUntil,
    waitUntilValue
  })
})

test('run timeline preserves time and state semantics', async ({
  page,
  fixtureRuntime
}, testInfo) => {
  await openAuthenticatedRuns(page)
  await skipEmptyExternalRuns(page, fixtureRuntime)
  await runRunsTimelineFlow({
    name: testInfo.project.name,
    page,
    base: fixtureRuntime.baseURL,
    waitUntil
  })
})

test('fixture admin controls isolate credentials and paginate transitions', async ({
  page,
  fixtureRuntime
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')
  test.skip(
    fixtureRuntime.server === undefined,
    'Fixture admin scenarios are not run against an external deployment.'
  )
  await openAuthenticatedRuns(page)
  await runFixtureAdminFlow({
    name: testInfo.project.name,
    page,
    base: fixtureRuntime.baseURL,
    waitUntil
  })
})

test('run errors distinguish session expiry from backend failure', async ({
  page,
  fixtureRuntime
}, testInfo) => {
  await openAuthenticatedRuns(page)
  await runRunsErrorFlow({
    name: testInfo.project.name,
    page,
    base: fixtureRuntime.baseURL,
    waitUntil
  })
})

test('running duration advances without a refetch', async ({
  page,
  browser,
  fixtureRuntime
}, testInfo) => {
  await openAuthenticatedRuns(page)
  await skipEmptyExternalRuns(page, fixtureRuntime)
  await runRunsClockCheck({
    name: testInfo.project.name,
    viewport: page.viewportSize(),
    browser,
    base: fixtureRuntime.baseURL,
    storageState: await page.context().storageState(),
    waitUntil
  })
})

test('Chinese run wording preserves publication and duration semantics', async ({
  page,
  browser,
  fixtureRuntime
}, testInfo) => {
  await openAuthenticatedRuns(page)
  await skipEmptyExternalRuns(page, fixtureRuntime)
  await runRunsChineseCheck({
    name: testInfo.project.name,
    viewport: page.viewportSize(),
    browser,
    base: fixtureRuntime.baseURL,
    storageState: await page.context().storageState(),
    waitUntilValue
  })
})
