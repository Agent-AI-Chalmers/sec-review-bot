import assert from 'node:assert/strict'

export async function runRunsFlow({
  name,
  viewport,
  page,
  server,
  waitUntil,
  expectedHeaders
}) {
  await page.screenshot({
    path: `/tmp/control-plane-ui-${name}.png`,
    fullPage: true
  })

  const body = await page.locator('body').boundingBox()
  if (body === null || body.width > viewport.width + 1) {
    throw new Error(`${name} layout overflows horizontally.`)
  }

  const rowCount = await page.locator('tbody tr').count()
  if (rowCount === 0) {
    if (server !== undefined) {
      throw new Error(`${name} fixtures returned no runs to assert against.`)
    }
    return false
  }

  const headerBox = await page.locator('header').boundingBox()
  const titleBox = await page
    .getByRole('heading', { name: 'Runs' })
    .boundingBox()
  assert.ok(
    headerBox !== null && headerBox.height <= 58,
    `${name} the header must keep its height (saw ${headerBox?.height})`
  )
  assert.ok(
    headerBox !== null &&
      titleBox !== null &&
      titleBox.y >= headerBox.y + headerBox.height - 1,
    `${name} the header must not overlap the page content`
  )

  const rowAction = page.locator('tbody tr:first-child .row-action')
  const rowActionOpacity = () =>
    rowAction.evaluate((element) => getComputedStyle(element).opacity)
  assert.strictEqual(await rowActionOpacity(), '0')
  await page.locator('tbody tr:first-child').hover()
  await waitUntil(
    async () => (await rowActionOpacity()) === '1',
    `${name} hovering a row must reveal its action`
  )
  await page.mouse.move(2, 2)
  await page.locator('tbody tr:first-child td a').first().focus()
  await waitUntil(
    async () => (await rowActionOpacity()) === '1',
    `${name} focusing a row must reveal its action too`
  )

  assert.match(
    (await page.locator('tbody tr:first-child td').nth(6).textContent()) ?? '',
    /\d+[dhms]\s+ago/,
    `${name} last activity must read as elapsed time`
  )
  assert.deepStrictEqual(
    await page.$$eval('thead th', (cells) =>
      cells.map((cell) => cell.textContent)
    ),
    expectedHeaders,
    `${name} run table headers changed`
  )
  assert.strictEqual(
    await page.locator('tbody tr:first-child .mantine-Badge-root').count(),
    0
  )
  assert.strictEqual(
    await page.locator('tbody tr:first-child .status-text').count(),
    3
  )

  const platformMark = page.locator('tbody tr:first-child .platform-mark')
  assert.strictEqual(await platformMark.locator('svg').count(), 1)
  assert.strictEqual(
    await platformMark
      .locator('.platform-mark-label')
      .evaluate((element) => getComputedStyle(element).display === 'none'),
    viewport.width <= 600,
    `${name} platform text must collapse only at the narrow breakpoint`
  )
  return true
}
