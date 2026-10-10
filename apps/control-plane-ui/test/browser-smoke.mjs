import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'

// Two modes:
//   - Self-managed (default): starts the Vite dev server with `CONTROL_PLANE_UI_DEV_FIXTURES=1`
//     and asserts the run-console invariants against the deterministic fixtures. No
//     database, BFF, or access token required, so CI can run it unattended.
//   - Attached: set CONTROL_PLANE_UI_BASE_URL (and CONTROL_PLANE_UI_ACCESS_TOKEN for an
//     authenticated BFF) to smoke an already-running deployment instead.
const FIXTURE_PORT = 5188
const EXTERNAL_BASE = process.env.CONTROL_PLANE_UI_BASE_URL
const TOKEN = process.env.CONTROL_PLANE_UI_ACCESS_TOKEN

// GitHub's ubuntu runner images preinstall Chrome; the apt package installs
// `google-chrome-stable` with a `google-chrome` symlink.
const CHROME_CANDIDATES = [
  process.env.CONTROL_PLANE_UI_CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable'
].filter((candidate) => candidate !== undefined)
const CHROME_PATH = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
if (CHROME_PATH === undefined) {
  throw new Error(
    `Chrome not found. Tried ${CHROME_CANDIDATES.join(', ')}. Set CONTROL_PLANE_UI_CHROME_PATH.`
  )
}

const EXPECTED_HEADERS = [
  'Run',
  'Workflow',
  'Execution',
  'Publication',
  'Last activity',
  'Failure code'
]

// Bind loopback explicitly. Vite's default host is `localhost`, which Node may
// resolve to ::1 first, leaving 127.0.0.1 refused.
let server
let base = EXTERNAL_BASE
if (base === undefined) {
  process.env.CONTROL_PLANE_UI_DEV_FIXTURES = '1'
  const { createServer } = await import('vite')
  server = await createServer({
    server: { host: '127.0.0.1', port: FIXTURE_PORT, strictPort: true }
  })
  await server.listen()
  base = `http://127.0.0.1:${FIXTURE_PORT}`
  await waitForServer(`${base}/`)
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`dev server at ${url} never became ready.`)
    await delay(250)
  }
}

const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
try {
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844 }]
  ]) {
    // Pin the locale: the console follows the browser language, and the assertions
    // below expect English labels and en-US date formatting.
    const context = await browser.newContext({ viewport, locale: 'en-US' })
    const page = await context.newPage()
    await page.goto(`${base}/runs`, { waitUntil: 'networkidle' })
    if (TOKEN !== undefined) {
      await page.getByLabel('Access token').fill(TOKEN)
      await page.getByRole('button', { name: 'Sign in' }).click()
      await page.waitForURL('**/runs')
    }
    await page.getByRole('heading', { name: 'Runs' }).waitFor()
    await page.screenshot({ path: `/tmp/control-plane-ui-${name}.png`, fullPage: true })

    // Layout invariant: nothing may overflow the viewport horizontally.
    const body = await page.locator('body').boundingBox()
    if (body === null || body.width > viewport.width + 1)
      throw new Error(`${name} layout overflows horizontally.`)

    const rowCount = await page.locator('tbody tr').count()
    if (rowCount === 0) {
      if (server !== undefined)
        throw new Error(`${name} fixtures returned no runs to assert against.`)
      await context.close()
      continue
    }

    // The list separates the two status axes into their own columns, and each
    // status is dot+text rather than a badge.
    assert.deepEqual(
      await page.$$eval('thead th', (cells) => cells.map((cell) => cell.textContent)),
      EXPECTED_HEADERS,
      `${name} run table headers changed`
    )
    assert.equal(
      await page.locator('tbody tr:first-child .mantine-Badge-root').count(),
      0,
      `${name} status cells must not render badges`
    )
    assert.equal(
      await page.locator('tbody tr:first-child .status-text').count(),
      2,
      `${name} expected one dot+text status per axis`
    )

    if (server !== undefined) {
      // Paging is part of the server contract: the console only offers a next page
      // when the response carries a cursor. Do not let the fixtures regress to a
      // single page, or this whole affordance silently stops being reachable.
      const firstCell = 'tbody tr td:first-child'
      const rows = () => page.$$eval(firstCell, (cells) => cells.map((cell) => cell.textContent))
      const previous = page.getByRole('button', { name: 'Previous page' })
      const next = page.getByRole('button', { name: 'Next page' })

      // The console states the page size on every request rather than relying on the
      // server default, so a selection must change what the server returns.
      const perPage = page.getByLabel('Per page')
      await perPage.selectOption('20')
      await page.waitForTimeout(750)
      assert.equal((await rows()).length, 20, `${name} selected page size must apply`)
      await perPage.selectOption('50')
      await page.waitForTimeout(750)
      assert.equal((await rows()).length, 50, `${name} default page size must apply`)

      // The fixture spreads its runs over more than a week, so each range preset must
      // narrow the list by a distinct amount rather than silently filtering nothing.
      const timeRange = page.getByLabel('Time range')
      const allRows = (await rows()).length
      await timeRange.selectOption('1h')
      await page.waitForTimeout(750)
      const hourRows = (await rows()).length
      assert.ok(hourRows < allRows, `${name} a one-hour range must narrow the list`)
      await timeRange.selectOption('24h')
      await page.waitForTimeout(750)
      const dayRows = (await rows()).length
      assert.ok(
        dayRows > hourRows && dayRows < allRows,
        `${name} a 24-hour range must sit between the hour and everything`
      )
      await timeRange.selectOption('')
      await page.waitForTimeout(750)
      assert.equal(
        (await rows()).length,
        allRows,
        `${name} clearing the range must restore the list`
      )

      const firstPage = await rows()
      assert.ok(await previous.isDisabled(), `${name} first page must disable the previous control`)
      assert.ok(!(await next.isDisabled()), `${name} first page must offer a next page`)

      await next.click()
      await page.waitForTimeout(750)
      const secondPage = await rows()
      assert.ok(secondPage.length > 0, `${name} next page must return runs`)
      assert.deepEqual(
        secondPage.filter((runId) => firstPage.includes(runId)),
        [],
        `${name} next page must not repeat the first page`
      )
      assert.ok(
        !(await previous.isDisabled()),
        `${name} a later page must enable the previous control`
      )

      // The API only pages forward, so returning has to reuse the remembered
      // cursor rather than silently sending the reader back to the first page.
      await previous.click()
      await page.waitForTimeout(750)
      assert.deepEqual(await rows(), firstPage, `${name} previous page must restore the first page`)

      await page.goto(`${base}/runs`, { waitUntil: 'networkidle' })
      await page.getByRole('heading', { name: 'Runs' }).waitFor()

      // The jump box is the only way to navigate by identity: the read API cannot
      // filter by run id, and the list shows only an abbreviation of it.
      await page.locator('tbody tr:first-child td a').first().click()
      await page.waitForSelector('.run-progress-timeline')
      const knownRunId = (await page.locator('.run-id').first().textContent())?.trim() ?? ''
      assert.ok(knownRunId.length > 0, `${name} the detail page must show the full run id`)
      await page.getByRole('link', { name: 'Back to runs' }).click()
      await page.getByRole('heading', { name: 'Runs' }).waitFor()

      const jump = page.getByLabel('Go to run ID')
      await jump.fill(knownRunId)
      await page.getByRole('button', { name: 'Go to run' }).click()
      await page.waitForSelector('.run-progress-timeline')
      assert.equal(
        (await page.locator('.run-id').first().textContent())?.trim(),
        knownRunId,
        `${name} the jump box must open the given run`
      )

      // Jumping to an unknown id from a detail page must not keep rendering the previous
      // run. React Router keeps this component mounted when only the id changes, so that
      // state has to be keyed by id or the 404 reads as a failed refresh of the old run.
      await jump.fill('00000000-0000-0000-0000-000000000000')
      await page.getByRole('button', { name: 'Go to run' }).click()
      await page.waitForTimeout(900)
      assert.ok(
        await page.getByRole('heading', { name: 'Run not found' }).isVisible(),
        `${name} an unknown run id must say the run is missing`
      )
      assert.equal(
        await page.getByText('Unable to load Control Plane').count(),
        0,
        `${name} an unknown run id must not show the generic error page`
      )
      assert.equal(
        await page.getByText('Refresh failed').count(),
        0,
        `${name} an unknown run id must not read as a failed refresh`
      )
      assert.equal(
        await page.locator('.run-id').count(),
        0,
        `${name} an unknown run id must not leave the previous run on screen`
      )

      await page.goto(`${base}/runs`, { waitUntil: 'networkidle' })
      await page.getByRole('heading', { name: 'Runs' }).waitFor()

      // A repository review publishes one step per delivery plus two summaries, so a
      // published one must render the multi-step delivery list.
      await page.getByLabel('Workflow').selectOption('repository-review')
      await page.getByLabel('Publication').selectOption('published')
      await page.waitForTimeout(800)
      await page.locator('tbody tr:first-child td a').first().click()
      await page.waitForSelector('.run-progress-timeline')
      const deliverySteps = await page.locator('.delivery-item').count()
      assert.ok(
        deliverySteps > 1,
        `${name} a published repository review must show its steps (saw ${deliverySteps})`
      )

      await page.goto(`${base}/runs`, { waitUntil: 'networkidle' })
      await page.getByRole('heading', { name: 'Runs' }).waitFor()
    }

    await page.locator('tbody tr:first-child td a').first().click()
    await page.waitForSelector('.run-progress-timeline', { timeout: 10_000 })
    const steps = await page.$$eval('.run-progress-timeline .mantine-Timeline-item', (items) =>
      items.map((item) => ({
        title: item.querySelector('.mantine-Timeline-itemTitle')?.textContent?.trim() ?? '',
        body: item.querySelector('.mantine-Timeline-itemBody')?.textContent?.trim() ?? ''
      }))
    )
    assert.deepEqual(
      steps.map((step) => step.title),
      ['Created', 'Execution', 'Publication'],
      `${name} timeline steps changed`
    )
    // Created and Execution always carry their timestamp. Publication carries one
    // only once the publication actually started: before then the field it would
    // read is the publication row's creation time at admission, which is how a
    // `pending` run used to render a publication timestamp earlier than Execution.
    const TIMESTAMP = /\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [AP]M/
    const [created, execution, publication] = steps
    assert.match(created.body, TIMESTAMP, `${name} "Created" must show a timestamp`)
    assert.match(execution.body, TIMESTAMP, `${name} "Execution" must show a timestamp`)
    assert.doesNotMatch(
      publication.body,
      TIMESTAMP,
      `${name} a publication that has not started must show no timestamp`
    )

    // The general form of the same bug: a timeline may not run backwards.
    const instants = [created, execution, publication]
      .map((step) => TIMESTAMP.exec(step.body)?.[0])
      .filter((text) => text !== undefined)
      .map((text) => Date.parse(text))
    for (let index = 1; index < instants.length; index += 1) {
      assert.ok(
        instants[index] >= instants[index - 1],
        `${name} timeline timestamps must not go backwards`
      )
    }
    assert.equal(
      await page.locator('.run-progress-timeline .status-text').count(),
      0,
      `${name} timeline must not repeat status words`
    )

    // Guard for the Mantine coupling described in styles.css: the rail is painted
    // from Timeline.Item::before and inherits the bullet colour, so a Mantine change
    // would silently revert it to the status colour or a solid line.
    const rail = await page.evaluate(() => {
      const item = document.querySelector('.run-progress-timeline .mantine-Timeline-item')
      if (item === null) return null
      const before = getComputedStyle(item, '::before')
      const bullet = item.querySelector('.mantine-Timeline-itemBullet')
      return {
        display: before.display,
        style: before.borderLeftStyle,
        color: before.borderLeftColor,
        bulletColor: bullet === null ? null : getComputedStyle(bullet).backgroundColor
      }
    })
    assert.notEqual(rail, null, `${name} timeline item missing`)
    if (rail !== null && rail.display !== 'none') {
      assert.equal(rail.style, 'dashed', `${name} timeline rail must stay dashed`)
      assert.notEqual(
        rail.color,
        rail.bulletColor,
        `${name} timeline rail must not reuse the status colour`
      )
    }

    // A publication that was ruled out is not a moment either, so it must stay
    // silent rather than repeat the execution failure time.
    await page.goto(`${base}/runs`, { waitUntil: 'networkidle' })
    await page.getByLabel('Execution').selectOption('failed')
    await page.waitForTimeout(750)
    assert.match(
      (await page.locator('tbody tr:first-child td').last().textContent()) ?? '',
      /[A-Z_]{4,}/,
      `${name} a failed row must show its failure code in the list`
    )
    await page.locator('tbody tr:first-child td a').first().click()
    await page.waitForSelector('.run-progress-timeline', { timeout: 10_000 })
    const ruledOut = await page.$$eval('.run-progress-timeline .mantine-Timeline-item', (items) =>
      items.map((item) => item.querySelector('.mantine-Timeline-itemBody')?.textContent ?? '')
    )
    assert.equal(ruledOut.length, 3, `${name} ruled-out timeline changed`)
    assert.doesNotMatch(
      ruledOut[2],
      TIMESTAMP,
      `${name} a ruled-out publication must show no timestamp`
    )

    console.log(`browser-smoke ${name}: ok (${base})`)
    await context.close()
  }
} finally {
  await browser.close()
  if (server !== undefined) await server.close()
}
