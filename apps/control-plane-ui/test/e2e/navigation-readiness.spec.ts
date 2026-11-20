import { expect, openAuthenticatedRuns, test } from './fixtures.js'

test('runs navigation waits for the UI without waiting for unrelated network activity', async ({
  page,
  fixtureRuntime
}) => {
  test.skip(fixtureRuntime.server === undefined, 'The local fixture owns the initial session.')
  test.setTimeout(30_000)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  await page.route('**/navigation-readiness-pending', async (route) => {
    started()
    await pending
    await route.fulfill({ status: 204 })
  })
  await page.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      void fetch('/navigation-readiness-pending')
    })
  })
  try {
    await openAuthenticatedRuns(page)
    await requestStarted
    await expect(page.locator('tbody tr').first()).toBeVisible()
  } finally {
    release()
  }
})

for (const { endpoint, readyRole, readyOptions } of [
  { endpoint: 'runs?*', readyRole: 'heading', readyOptions: { name: 'Runs', exact: true } },
  { endpoint: 'runs/parked', readyRole: 'table', readyOptions: {} }
] as const) {
  test(`a pending ${endpoint} request can still require sign-in after the page mounts`, async ({
    page,
    fixtureRuntime
  }) => {
    test.skip(
      fixtureRuntime.server === undefined,
      'Authentication is simulated on the local fixture.'
    )
    let signIns = 0
    await page.route('**/api/session', async (route) => {
      if (route.request().method() === 'POST') {
        signIns += 1
      }
      await route.continue()
    })
    await page.route(
      `**/api/${endpoint}`,
      async (route) => {
        await page.getByRole(readyRole, readyOptions).waitFor()
        await route.fulfill({ status: 401, json: { error: 'unauthorized' } })
      },
      { times: 1 }
    )
    await openAuthenticatedRuns(page, 'fixture-readiness-token')
    await expect(page.locator('tbody tr').first()).toBeVisible()
    expect(signIns).toBe(1)
  })
}
