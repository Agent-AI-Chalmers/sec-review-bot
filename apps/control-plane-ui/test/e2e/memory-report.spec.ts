import { expect, type Page } from '@playwright/test'
import { test, openAuthenticatedRuns } from './fixtures.js'

/** Force a one-row page so every list has several pages to walk. */
async function forceOneRowPages(page: Page, path: string): Promise<void> {
  await page.route(`**/api/memory/${path}?*`, (route) => {
    const url = new URL(route.request().url())
    url.searchParams.set('limit', '1')
    return route.continue({ url: url.toString() })
  })
}

async function openRevisionList(page: Page): Promise<void> {
  await openAuthenticatedRuns(page)
  await page.goto('/memory', { waitUntil: 'networkidle' })
  await page.getByRole('tab', { name: 'Revisions' }).click()
  await page.getByText('List', { exact: true }).click()
}

test('a report decision reveals its observation in the revision-filtered list', async ({
  page
}) => {
  await openRevisionList(page)
  await page.getByRole('button', { name: 'Decisions' }).first().click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'View observation' })
    .first()
    .click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Observations' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(
    page.getByText('Showing observations included in revision 2.')
  ).toBeVisible()
  const row = page.locator('[data-extraction-row="fixture-extraction-2"]')
  await expect(row).toBeVisible()
  await expect(row).toBeFocused()
  await expect(page.locator('[data-extraction-row]')).toHaveCount(3)

  await page.getByRole('button', { name: 'Show all observations' }).click()
  await expect(
    page.getByText('Showing observations included in revision 2.')
  ).toHaveCount(0)
  await expect(page.getByLabel('Next page')).toHaveCount(0)
})

test('the observation list pages forward and back with the shared pager', async ({
  page
}) => {
  await forceOneRowPages(page, 'observations')
  await openAuthenticatedRuns(page)
  await page.goto('/memory', { waitUntil: 'networkidle' })
  await page.getByRole('tab', { name: 'Observations' }).click()
  const rows = page.locator('[data-extraction-row]')
  await expect(rows).toHaveCount(1)
  const first = await rows.first().getAttribute('data-extraction-row')
  await page.getByLabel('Next page').click()
  await expect(rows.first()).not.toHaveAttribute('data-extraction-row', first!)
  await page.getByLabel('Previous page').click()
  await expect(rows.first()).toHaveAttribute('data-extraction-row', first!)
})

test('revision history pages in the list while the graph keeps the newest window', async ({
  page
}) => {
  await forceOneRowPages(page, 'revisions')
  await openRevisionList(page)
  const rows = page.locator('[data-memory-revision]')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveAttribute('data-memory-revision', '3')
  await page.getByLabel('Next page').click()
  await expect(rows.first()).toHaveAttribute('data-memory-revision', '2')
  await page.getByLabel('Next page').click()
  await expect(rows.first()).toHaveAttribute('data-memory-revision', '1')
  await expect(page.getByLabel('Next page')).toBeDisabled()

  await page.getByText('Graph', { exact: true }).click()
  await expect(page.locator('.revision-graph-node')).toHaveCount(1)
  await expect(
    page.getByText(
      'The graph shows the newest 50 revisions. Use the list to browse older ones.'
    )
  ).toBeVisible()
})
