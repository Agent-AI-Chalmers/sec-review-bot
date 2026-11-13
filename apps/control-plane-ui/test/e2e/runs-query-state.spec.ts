import AxeBuilder from '@axe-core/playwright'

import {
  expect,
  openAuthenticatedRuns,
  openRunFilters,
  test
} from './fixtures.js'

test.beforeEach(async ({ page, fixtureRuntime }) => {
  test.skip(
    fixtureRuntime.server === undefined,
    'Query fault injection requires local fixture data.'
  )
  await page.addInitScript(() =>
    localStorage.setItem('ui-auto-refresh', 'false')
  )
})

test('changed filters hide old rows and cursors while loading and recover without losing the query', async ({
  page
}) => {
  await openAuthenticatedRuns(page)
  await expect(page.locator('tbody tr')).toHaveCount(20)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let failed = false
  await page.route('**/api/runs?*', async (route) => {
    if (
      !failed &&
      new URL(route.request().url()).searchParams.get('execution_status') ===
        'succeeded'
    ) {
      failed = true
      await gate
      await route.fulfill({
        status: 500,
        json: { error: 'Fixture unavailable' }
      })
    } else {
      await route.continue()
    }
  })
  try {
    await openRunFilters(page)
    const execution = page.getByRole('combobox', {
      name: 'Execution',
      exact: true
    })
    await execution.click()
    await page.getByRole('option', { name: 'Succeeded', exact: true }).click()
    await expect(
      page.getByRole('status').filter({ hasText: 'Loading runs' })
    ).toBeVisible()
    await expect(page.locator('tbody tr')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Next page' })).toHaveCount(0)
    release()
    await expect(
      page.getByRole('button', { name: 'Retry', exact: true })
    ).toBeVisible()
    await expect(execution).toHaveValue('Succeeded')
    await expect(page.locator('tbody tr')).toHaveCount(0)
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.locator('tbody tr').first()).toBeVisible()
    await expect(page.locator('tbody tr td:nth-child(5)')).toHaveText(
      Array(await page.locator('tbody tr').count()).fill('Succeeded')
    )
    await expect(page).toHaveURL(
      (url) => url.searchParams.get('execution_status') === 'succeeded'
    )
  } finally {
    release()
    await page.unrouteAll({ behavior: 'wait' })
  }
})

test('same-query refresh failures retain the current rows and explain their age', async ({
  page
}) => {
  await openAuthenticatedRuns(page)
  const links = page.locator('tbody tr td:first-child a')
  await expect(links).toHaveCount(20)
  const previous = await links.allTextContents()
  await page.route('**/api/runs?*', (route) =>
    route.fulfill({ status: 500, json: { error: 'Fixture unavailable' } })
  )
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Showing the last available data'
  )
  await expect(links).toHaveText(previous)
})

test('empty filtered results can clear the query without changing the page size', async ({
  page
}) => {
  await page.goto('/runs?limit=50&from=2099-01-01T00%3A00%3A00Z', {
    waitUntil: 'networkidle'
  })
  await expect(page.locator('tbody tr')).toHaveCount(0)
  await page
    .getByRole('button', { name: 'Clear filters', exact: true })
    .last()
    .click()
  await expect(page).toHaveURL((url) => url.search === '?limit=50')
  await expect(page.locator('tbody tr')).toHaveCount(50)
  await expect(
    page.getByRole('combobox', { name: 'Rows per page' })
  ).toHaveValue('50')
  await expect(
    page.getByRole('button', { name: 'Previous page' })
  ).toBeDisabled()
})

test('mobile filters disclose controls and retain an applied summary when collapsed', async ({
  page
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'mobile',
    'Disclosure is specific to narrow screens.'
  )
  await openAuthenticatedRuns(page)
  const toggle = page.getByRole('button', { name: /^Filters/ })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(
    page.getByRole('combobox', { name: 'Execution', exact: true })
  ).toBeHidden()
  await toggle.click()
  await expect(
    page.getByRole('combobox', { name: 'Time range', exact: true })
  ).toBeVisible()
  await page.getByRole('combobox', { name: 'Execution', exact: true }).click()
  await page.getByRole('option', { name: 'Succeeded', exact: true }).click()
  await expect(toggle).toHaveAccessibleName('Filters (1)')
  await expect(page.locator('tbody tr').first()).toBeVisible()
  // The applied summary must remain readable alongside the expanded controls.
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(accessibility.violations).toEqual([])
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(
    page.getByRole('combobox', { name: 'Execution', exact: true })
  ).toBeHidden()
  await expect(
    page.getByText('Execution: Succeeded', { exact: true })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(toggle).toHaveAccessibleName('Filters')
  await expect(page).toHaveURL((url) => url.search === '')
})
