import assert from 'node:assert/strict'

export async function runFixtureAdminFlow({ name, page, base, waitUntil }) {
  await page.goto(`${base}/runs`, { waitUntil: 'networkidle' })
  await page.getByTestId('parked-runs').waitFor()
  const parkedRunId = await page.evaluate(async () => {
    const response = await fetch('/api/runs/parked')
    const body = await response.json()
    return body.blocks[0].run_id
  })
  await page
    .getByTestId('parked-runs')
    .getByRole('button', { name: 'View', exact: true })
    .click()
  const parkedDrawer = page.getByRole('dialog')
  await parkedDrawer.waitFor()
  assert.match(
    (await parkedDrawer.textContent()) ?? '',
    /Waiting \d/,
    `${name} the parked queue must show how long each run has waited`
  )
  await page.keyboard.press('Escape')
  await parkedDrawer.waitFor({ state: 'hidden' })
  await page.goto(`${base}/runs/${encodeURIComponent(parkedRunId)}`, {
    waitUntil: 'networkidle'
  })
  await page.getByTestId('blocked-run').waitFor()
  assert.match(
    (await page.getByTestId('blocked-run').textContent()) ?? '',
    /Waiting \d/,
    `${name} the parked detail banner must show how long the run has waited`
  )
  await page.route('**/api/admin/runs/*/resume', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{"error":"admin_token_required"}'
    })
  )
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  const resumeDialog = page.getByRole('dialog', { name: 'Resume this run' })
  await resumeDialog.getByLabel('Admin token').fill('rejected-token')
  await resumeDialog
    .getByRole('button', { name: 'Resume run', exact: true })
    .click()
  await resumeDialog
    .getByText('That admin token was rejected.', { exact: true })
    .waitFor()
  assert.strictEqual(
    await page.getByLabel('Access token').count(),
    0,
    'an admin-token 401 must stay in the maintenance dialog'
  )
  await page.unroute('**/api/admin/runs/*/resume')

  await page.route('**/api/runs/*/events', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    const sample = body.events.find((event) => event.from_status !== null)
    assert.ok(sample, `${name} fixtures need a transition to synthesize`)
    const extra = Array.from({ length: 13 }, (_, index) => ({
      ...sample,
      event_id: `synthetic-transition-${index}`,
      occurred_at: new Date(
        Date.parse(sample.occurred_at) + (index + 1) * 1000
      ).toISOString()
    }))
    await route.fulfill({
      response,
      json: { events: [...body.events, ...extra] }
    })
  })
  await page.goto(`${base}/runs`, { waitUntil: 'networkidle' })
  await page.locator('tbody tr td a').first().click()
  await page.waitForSelector('.run-progress-timeline')
  const transitions = page.locator('.run-transitions')
  await transitions.locator('.transitions-entry').click()
  await transitions.locator('.transitions-body').waitFor()
  assert.strictEqual(
    await transitions.locator('.run-transition').count(),
    12,
    `${name} transitions must cap a page at 12 rows`
  )
  const pager = transitions.locator('.mantine-Pagination-root')
  assert.strictEqual(await pager.count(), 1)
  assert.strictEqual(
    await pager.evaluate((element) => getComputedStyle(element).justifyContent),
    'center',
    `${name} transition pagination must be centered`
  )
  await pager.getByRole('button', { name: '2', exact: true }).click()
  await waitUntil(
    async () => (await transitions.locator('.run-transition').count()) < 12,
    `${name} the second transition page must load fewer than a full page`
  )
  await page.unroute('**/api/runs/*/events')
}

export async function runRunsErrorFlow({ name, page, base, waitUntil }) {
  await page.goto(`${base}/runs`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Runs' }).waitFor()
  await page.route('**/api/runs*', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{"error":"unauthorized"}'
    })
  )
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.getByLabel('Access token').waitFor({ state: 'visible' })
  await page.unroute('**/api/runs*')

  await page.goto(`${base}/runs`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Runs' }).waitFor()
  await page.route('**/api/runs*', (route) =>
    route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: '{"error":"review_runs_unavailable"}'
    })
  )
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await waitUntil(
    async () =>
      /Review Runs is unavailable\./.test(
        (await page.locator('[role="alert"]').first().textContent()) ?? ''
      ),
    `${name} an unavailable Review Runs must say so`
  )
  await page.unroute('**/api/runs*')
}
