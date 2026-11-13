import { expect, test } from './fixtures.js'

test('narrow revision selection keeps its actions on screen', async ({
  page
}) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto('/memory', { waitUntil: 'networkidle' })
  await page.getByRole('tab', { name: 'Revisions', exact: true }).click()
  await page.locator('[data-revision-node="60"]').click()
  const selection = page.locator('.revision-graph-selection')
  await expect(selection).toBeFocused()
  await expect(selection).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320
  )
  for (const button of await selection.getByRole('button').all())
    await expect(button).toBeInViewport()
})

test('long uploaded names fit the Viewer before and after editing input', async ({
  page
}) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto('/viewer', { waitUntil: 'networkidle' })
  await page.locator('input[type="file"]').setInputFiles({
    name: 'trajectory_'.repeat(15) + '.jsonl',
    mimeType: 'application/x-ndjson',
    buffer: Buffer.from(
      JSON.stringify({
        seq: 1,
        event: 'message',
        message: { id: 'hello', role: 'assistant', content: 'Hello' }
      })
    )
  })
  await expect(page.locator('.trajectory-timeline')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320
  )
  await page.getByRole('button', { name: 'Edit input', exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320
  )
})

test('memory lists keep identity and actions together at phone width', async ({
  page
}) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto('/memory', { waitUntil: 'networkidle' })
  await page.getByRole('tab', { name: 'Observations', exact: true }).click()
  const row = page.locator('.memory-table tbody tr').first()
  await expect(row).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320
  )
  expect(
    await page
      .locator('.memory-table')
      .evaluate((el) => el.scrollWidth <= el.clientWidth)
  ).toBe(true)
  await page.getByRole('tab', { name: 'Revisions', exact: true }).click()
  await page.getByText('List', { exact: true }).click()
  await expect(
    page.locator('.memory-table:visible tbody tr').first()
  ).toBeVisible()
  expect(
    await page
      .locator('.memory-table:visible')
      .evaluate((el) => el.scrollWidth <= el.clientWidth)
  ).toBe(true)
})

test('failed file previews retry in place', async ({ page }) => {
  let failed = false
  await page.route('**/api/memory/revisions/2/content', async (route) => {
    if (!failed) {
      failed = true
      await route.fulfill({ status: 500, json: { error: 'temporary' } })
    } else await route.continue()
  })
  await page.goto('/memory/revisions/2/tree', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.locator('.memory-markdown')).toBeVisible()
  await expect(page).toHaveURL(/\/memory\/revisions\/2\/tree$/)
})

test('restore failures stay inside the confirmation dialog', async ({
  page
}) => {
  await page.route('**/api/memory/restore', (route) =>
    route.fulfill({ status: 409, json: { error: 'conflict' } })
  )
  await page.goto('/memory', { waitUntil: 'networkidle' })
  await page.getByRole('tab', { name: 'Revisions', exact: true }).click()
  await page.locator('[data-revision-node="60"]').click()
  await page
    .locator('.revision-graph-selection')
    .getByRole('button', { name: 'Set current', exact: true })
    .click()
  const dialog = page.getByRole('dialog')
  await dialog
    .getByRole('button', { name: 'Set as current', exact: true })
    .click()
  await expect(
    dialog.getByRole('alert').filter({ hasText: 'active revision changed' })
  ).toBeVisible()
})

test('file tree scrollbar cannot intercept the sticky modal close button', async ({
  page
}) => {
  // The inner scrollbar crosses the sticky header when the outer dialog scrolls.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/memory', { waitUntil: 'networkidle' })
  await page.getByRole('tab', { name: 'Revisions', exact: true }).click()
  await page
    .locator('.revision-graph-selection')
    .getByRole('button', { name: 'Files', exact: true })
    .click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'triage.md', exact: true }).click()
  await expect(dialog.locator('.file-workspace-preview h1')).toBeVisible()
  const viewport = dialog.locator('.mantine-ScrollArea-viewport')
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0)
  const close = dialog.locator('.mantine-Modal-close')
  const point = await dialog.evaluate((element) => {
    const button = element.querySelector('.mantine-Modal-close')!
    const thumb = element.querySelector('.mantine-ScrollArea-thumb')!
    const before = thumb.getBoundingClientRect()
    const target = button.getBoundingClientRect()
    element.scrollTop +=
      before.y + before.height / 2 - (target.y + target.height / 2)
    const after = thumb.getBoundingClientRect()
    const x = Math.max(after.left, target.left) + 1
    const y = Math.max(after.top, target.top) + 1
    return {
      x,
      y,
      intersects:
        x < Math.min(after.right, target.right) &&
        y < Math.min(after.bottom, target.bottom)
    }
  })
  expect(point.intersects).toBe(true)
  expect(
    await close.evaluate(
      (button, point) =>
        button.contains(document.elementFromPoint(point.x, point.y)),
      point
    )
  ).toBe(true)
  await page.mouse.click(point.x, point.y)
  await expect(dialog).toBeHidden()
})
