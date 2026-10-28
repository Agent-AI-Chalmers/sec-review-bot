import assert from 'node:assert/strict'

async function chooseSelect(page, label, option) {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

export async function runFixtureRunListFlow({ name, page, base, waitUntil }) {
  const rows = () =>
    page.$$eval('tbody tr td:first-child', (cells) =>
      cells.map((cell) => cell.textContent)
    )
  const previous = page.getByRole('button', { name: 'Previous page' })
  const next = page.getByRole('button', { name: 'Next page' })
  const perPage = page.getByRole('combobox', { name: 'Rows per page' })
  const choosePageSize = async (size) => {
    await perPage.click()
    await page
      .locator('[role="option"]', { hasText: new RegExp(`^${size}$`) })
      .first()
      .click()
  }

  await choosePageSize('20')
  await waitUntil(
    async () => (await rows()).length === 20,
    `${name} selected page size must apply`
  )
  await choosePageSize('50')
  await waitUntil(
    async () => (await rows()).length === 50,
    `${name} default page size must apply`
  )

  await page.getByRole('button', { name: 'More filters' }).click()
  const allRows = (await rows()).length
  await chooseSelect(page, 'Time range', 'Last hour')
  await waitUntil(
    async () => (await rows()).length < allRows,
    `${name} a one-hour range must narrow the list`
  )
  const hourRows = (await rows()).length
  await chooseSelect(page, 'Time range', 'Last 24 hours')
  await waitUntil(async () => {
    const count = (await rows()).length
    return count > hourRows && count < allRows
  }, `${name} a 24-hour range must sit between the hour and everything`)
  await chooseSelect(page, 'Time range', 'All')
  await waitUntil(
    async () => (await rows()).length === allRows,
    `${name} clearing the range must restore the list`
  )

  await chooseSelect(page, 'Preparation', 'Failed')
  await waitUntil(
    async () => (await rows()).length < allRows,
    `${name} a preparation state must narrow the list`
  )
  assert.ok(
    (await page.locator('tbody tr').count()) > 0,
    `${name} a preparation filter must leave rows to inspect`
  )
  await chooseSelect(page, 'Preparation', 'All')
  await waitUntil(
    async () => (await rows()).length === allRows,
    `${name} clearing the preparation filter must restore the list`
  )

  await page.getByRole('combobox', { name: 'Execution', exact: true }).click()
  const executionStates = await page.getByRole('option').allTextContents()
  assert.ok(
    executionStates.includes('Uncertain') &&
      executionStates.includes('Skipped'),
    `${name} the Execution filter must include uncertain and skipped`
  )
  await page.keyboard.press('Escape')
  await chooseSelect(page, 'Execution', 'Uncertain')
  await waitUntil(
    async () => (await rows()).length < allRows,
    `${name} the uncertain execution state must narrow the list`
  )
  await chooseSelect(page, 'Execution', 'All')
  await waitUntil(
    async () => (await rows()).length === allRows,
    `${name} clearing the execution filter must restore the list`
  )

  const firstPage = await rows()
  assert.ok(await previous.isDisabled())
  assert.ok(!(await next.isDisabled()))
  await next.click()
  await waitUntil(async () => {
    const pageIds = await rows()
    return (
      pageIds.length > 0 && pageIds.every((runId) => !firstPage.includes(runId))
    )
  }, `${name} next page must not repeat the first page`)
  assert.ok((await rows()).length > 0)
  assert.ok(!(await previous.isDisabled()))
  await previous.click()
  await waitUntil(
    async () => JSON.stringify(await rows()) === JSON.stringify(firstPage),
    `${name} previous page must restore the first page`
  )

  await page.goto(`${base}/runs`, { waitUntil: 'networkidle' })
  await page.locator('tbody tr:first-child td a').first().click()
  await page.waitForSelector('.run-progress-timeline')
  const knownRunId =
    (await page.locator('.run-id').first().textContent())?.trim() ?? ''
  assert.ok(knownRunId.length > 0)
  await page.getByRole('link', { name: 'Back to runs' }).click()
  await page.waitForURL(`${base}/runs`)
  await page.getByRole('heading', { name: 'Runs' }).waitFor()
  await page.getByRole('button', { name: 'Jump to run' }).click()
  const jump = page.getByRole('dialog').getByLabel('Go to run ID')
  await jump.waitFor()
  await jump.fill(knownRunId)
  await page.getByRole('button', { name: 'Go to run' }).click()
  await page.waitForSelector('.run-progress-timeline')
  assert.strictEqual(
    (await page.locator('.run-id').first().textContent())?.trim(),
    knownRunId
  )

  await page.getByRole('button', { name: 'Jump to run' }).click()
  await jump.fill('00000000-0000-0000-0000-000000000000')
  await page.getByRole('button', { name: 'Go to run' }).click()
  await page.getByRole('heading', { name: 'Run not found' }).waitFor()
  assert.strictEqual(
    await page.getByText('Unable to load this page').count(),
    0
  )
  assert.strictEqual(await page.getByText('Refresh failed').count(), 0)
  assert.strictEqual(await page.locator('.run-id').count(), 0)
}
