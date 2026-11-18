import { expect, type Page } from '@playwright/test'
import { test, openAuthenticatedRuns } from './fixtures.js'

test.beforeEach(async ({ fixtureRuntime }) => {
  test.skip(
    fixtureRuntime.server === undefined,
    'Version and observation scenarios require the stable local fixture data.'
  )
})

/** Force a one-row page so every list has several pages to walk. */
async function forceOneRowPages(page: Page, path: string): Promise<void> {
  await page.route(`**/api/memory/${path}?*`, (route) => {
    const url = new URL(route.request().url())
    url.searchParams.set('limit', '1')
    return route.continue({ url: url.toString() })
  })
}

async function openVersionList(page: Page): Promise<void> {
  await openAuthenticatedRuns(page)
  await page.goto('/memory', { waitUntil: 'networkidle' })
  await page.getByRole('tab', { name: 'Versions' }).click()
  await page.getByText('List', { exact: true }).click()
}

test('a report decision reveals its observation in the version-filtered list', async ({ page }) => {
  await openVersionList(page)
  await page.getByRole('combobox', { name: 'Rows per page', exact: true }).click()
  await page.getByRole('option', { name: '100', exact: true }).click()
  await page.locator('[data-memory-version="2"]').getByRole('button', { name: 'Decisions' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'View observation' }).first().click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Observations' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(page.getByText('Showing observations included in version 2.')).toBeVisible()
  const row = page.locator('[data-observation-row="observation-fixture-extraction-2-1"]')
  await expect(row).toBeVisible()
  await expect(row).toBeFocused()
  await expect(
    page.locator('[data-observation-row="observation-fixture-extraction-2-2"]')
  ).toHaveCount(0)
  await expect(page.locator('[data-observation-row]')).toHaveCount(3)

  await page.getByRole('button', { name: 'Show all observations' }).click()
  await expect(page.getByText('Showing observations included in version 2.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled()
})

test('the observation list pages forward and back with the shared pager', async ({ page }) => {
  await forceOneRowPages(page, 'observations')
  await openAuthenticatedRuns(page)
  await page.goto('/memory', { waitUntil: 'networkidle' })
  await page.getByRole('tab', { name: 'Observations' }).click()
  const rows = page.locator('[data-observation-row]')
  await expect(rows).toHaveCount(1)
  const first = await rows.first().getAttribute('data-observation-row')
  await page.getByRole('button', { name: 'Next page', exact: true }).click()
  await expect(rows.first()).not.toHaveAttribute('data-observation-row', first!)
  await page.getByRole('button', { name: 'Previous page', exact: true }).click()
  await expect(rows.first()).toHaveAttribute('data-observation-row', first!)
})

test('version history pages in the list while the graph keeps the newest window', async ({
  page
}) => {
  await forceOneRowPages(page, 'versions')
  await openVersionList(page)
  const rows = page.locator('[data-memory-version]')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveAttribute('data-memory-version', '60')
  await page.getByRole('button', { name: 'Next page', exact: true }).click()
  await expect(rows.first()).toHaveAttribute('data-memory-version', '59')
  await page.getByRole('button', { name: 'Next page', exact: true }).click()
  await expect(rows.first()).toHaveAttribute('data-memory-version', '58')
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled()

  await page.getByText('Graph', { exact: true }).click()
  await expect(page.locator('.version-graph-node')).toHaveCount(1)
  await expect(page.getByText('Versions 60–60', { exact: true })).toBeVisible()
})

test('observation navigation centers the graph and can return to latest', async ({ page }) => {
  await openAuthenticatedRuns(page)
  await page.goto('/memory', { waitUntil: 'networkidle' })
  await page.getByRole('tab', { name: 'Observations' }).click()
  const centered = page.waitForRequest((request) =>
    request.url().includes('/memory/versions?limit=50&before_version=51')
  )
  await page.getByRole('combobox', { name: 'Rows per page', exact: true }).click()
  await page.getByRole('option', { name: '100', exact: true }).click()
  await page
    .locator('[data-observation-row="observation-fixture-extraction-2-1"]')
    .getByRole('button', { name: 'version 2', exact: true })
    .click()
  await centered
  await expect(page.locator('[data-version-node="2"]')).toBeFocused()
  await expect(page.locator('[data-version-node="2"]')).toHaveAttribute('data-selected', 'true')
  const latest = page.waitForRequest((request) =>
    request.url().endsWith('/memory/versions?limit=50')
  )
  await page.getByRole('button', { name: 'Back to latest' }).click()
  await latest
  await expect(page.getByRole('button', { name: 'Back to latest' })).toBeDisabled()
})

test('the default history centers an older version and returns to the latest window', async ({
  page
}) => {
  await openAuthenticatedRuns(page)
  await page.goto('/memory', { waitUntil: 'networkidle' })
  await page.getByRole('tab', { name: 'Versions' }).click()
  await expect(page.locator('.version-graph-node')).toHaveCount(50)
  await expect(page.getByText('Versions 11–60', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Observations' }).click()
  await page.getByRole('combobox', { name: 'Rows per page', exact: true }).click()
  await page.getByRole('option', { name: '100', exact: true }).click()
  await page.getByRole('button', { name: 'version 29', exact: true }).click()
  await expect(page.locator('[data-version-node="29"]')).toBeFocused()
  await expect(page.getByText('Versions 5–54', { exact: true })).toBeVisible()
  expect((await page.request.get('/api/memory/versions/29/content')).ok()).toBe(true)
  await page.getByRole('button', { name: 'Back to latest' }).click()
  await expect(page.getByText('Versions 11–60', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Back to latest' })).toBeDisabled()
})

test('refreshing a historical graph preserves the reader scroll position', async ({ page }) => {
  await openAuthenticatedRuns(page)
  await page.goto('/memory', { waitUntil: 'networkidle' })
  const autoRefresh = page.getByRole('switch', {
    name: 'Auto refresh',
    exact: true
  })
  if (await autoRefresh.isChecked()) await autoRefresh.uncheck()
  await page.getByRole('tab', { name: 'Observations' }).click()
  await page.getByRole('combobox', { name: 'Rows per page', exact: true }).click()
  await page.getByRole('option', { name: '100', exact: true }).click()
  await page.getByRole('button', { name: 'version 2', exact: true }).first().click()
  await expect(page.locator('[data-version-node="2"]')).toBeFocused()
  const viewport = page.locator('.version-graph-scroll')
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(5000)
  await viewport.evaluate((element) => {
    element.scrollTo({ top: 123, behavior: 'instant' })
  })
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(123)
})
