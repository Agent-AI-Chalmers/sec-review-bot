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

/** Relative luminance contrast, so the theme can be checked without pixel baselines. */
const CONTRAST = `(() => {
  const parse = (value) => {
    const match = value.match(/rgba?\\(([^)]+)\\)/)
    if (!match) return null
    const parts = match[1].split(',').map((part) => Number.parseFloat(part))
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }
  const luminance = ({ r, g, b }) => {
    const channel = (c) => {
      const s = c / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }
  const background = (element) => {
    let node = element
    while (node) {
      const colour = parse(getComputedStyle(node).backgroundColor)
      if (colour && colour.a > 0.9) return colour
      node = node.parentElement
    }
    return { r: 255, g: 255, b: 255, a: 1 }
  }
  const ratio = (selector) => {
    const element = document.querySelector(selector)
    if (!element) return null
    const foreground = parse(getComputedStyle(element).color)
    if (!foreground) return null
    const a = luminance(foreground)
    const b = luminance(background(element))
    return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100
  }
  return {
    background: background(document.body),
    title: ratio('h1'),
    cell: ratio('tbody td span')
  }
})()`

const EXPECTED_HEADERS = [
  'Run',
  'Workflow',
  'Preparation',
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
    if (Date.now() > deadline)
      throw new Error(`dev server at ${url} never became ready.`)
    await delay(250)
  }
}

// Poll a predicate until it is true, instead of sleeping a fixed amount and
// hoping the UI has settled. The predicate runs immediately and then every
// interval, so a condition that is already true costs nothing.
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

// Like waitUntil, but for a producer whose current value is wanted back: poll
// until the predicate accepts the value, then return it.
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

const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  headless: true
})
try {
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844 }]
  ]) {
    // Pin the locale: the console follows the browser language, and the assertions
    // below expect English labels and en-US date formatting.
    const context = await browser.newContext({
      viewport,
      locale: 'en-US',
      permissions: ['clipboard-read', 'clipboard-write']
    })
    const page = await context.newPage()
    await page.goto(`${base}/runs`, { waitUntil: 'networkidle' })
    if (TOKEN !== undefined) {
      await page.getByLabel('Access token').fill(TOKEN)
      await page.getByRole('button', { name: 'Sign in' }).click()
      await page.waitForURL('**/runs')
    }
    await page.getByRole('heading', { name: 'Runs' }).waitFor()
    await page.screenshot({
      path: `/tmp/control-plane-ui-${name}.png`,
      fullPage: true
    })

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

    // The header is a fixed height and must not grow over the page: expanding content
    // once pushed the "Open" control on top of the content and swallowed its clicks.
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

    // Row actions stay out of the way until the row is used, but they must be reachable
    // without a mouse as well — hiding an action behind hover alone loses it for keyboards.
    const rowAction = page.locator('tbody tr:first-child .row-action')
    const rowActionOpacity = () =>
      rowAction.evaluate((element) => getComputedStyle(element).opacity)
    assert.strictEqual(
      await rowActionOpacity(),
      '0',
      `${name} a row action must rest hidden`
    )
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

    // The recency column leads with how long ago, so the feed can be scanned by eye.
    assert.match(
      (await page.locator('tbody tr:first-child td').nth(5).textContent()) ??
        '',
      /\d+[dhms]\s+ago/,
      `${name} last activity must read as elapsed time`
    )

    // The list separates all three lifecycle axes into their own columns, and each
    // status is dot+text rather than a badge.
    assert.deepStrictEqual(
      await page.$$eval('thead th', (cells) =>
        cells.map((cell) => cell.textContent)
      ),
      EXPECTED_HEADERS,
      `${name} run table headers changed`
    )
    assert.strictEqual(
      await page.locator('tbody tr:first-child .mantine-Badge-root').count(),
      0,
      `${name} status cells must not render badges`
    )
    assert.strictEqual(
      await page.locator('tbody tr:first-child .status-text').count(),
      3,
      `${name} expected one dot+text status per lifecycle axis`
    )

    if (server !== undefined) {
      // Paging is part of the server contract: the console only offers a next page
      // when the response carries a cursor. Do not let the fixtures regress to a
      // single page, or this whole affordance silently stops being reachable.
      const firstCell = 'tbody tr td:first-child'
      const rows = () =>
        page.$$eval(firstCell, (cells) => cells.map((cell) => cell.textContent))
      const previous = page.getByRole('button', { name: 'Previous page' })
      const next = page.getByRole('button', { name: 'Next page' })

      // The console states the page size on every request rather than relying on the
      // server default, so a selection must change what the server returns. Page size is a
      // Mantine select (a combobox with a dropdown), exercised the way a reader would.
      const perPage = page.getByRole('combobox', {
        name: 'Rows per page'
      })
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

      // The fixture spreads its runs over more than a week, so each range preset must
      // narrow the list by a distinct amount rather than silently filtering nothing.
      const timeRange = page.getByLabel('Time range')
      const allRows = (await rows()).length
      await timeRange.selectOption('1h')
      await waitUntil(
        async () => (await rows()).length < allRows,
        `${name} a one-hour range must narrow the list`
      )
      const hourRows = (await rows()).length
      await timeRange.selectOption('24h')
      await waitUntil(async () => {
        const count = (await rows()).length
        return count > hourRows && count < allRows
      }, `${name} a 24-hour range must sit between the hour and everything`)
      await timeRange.selectOption('')
      await waitUntil(
        async () => (await rows()).length === allRows,
        `${name} clearing the range must restore the list`
      )

      // Preparation is a lifecycle axis of its own, not a facet of the Execution or
      // publication state: selecting one of its states must narrow the list and every
      // surviving row must report that state in its Preparation cell.
      const preparation = page.getByLabel('Preparation')
      await preparation.selectOption('failed')
      await waitUntil(
        async () => (await rows()).length < allRows,
        `${name} a preparation state must narrow the list`
      )
      const preparationCells = await page.$$eval('tbody tr td', (cells) =>
        cells.map((cell) => cell.textContent)
      )
      assert.ok(
        preparationCells.length > 0,
        `${name} a preparation filter must leave rows to inspect`
      )
      await preparation.selectOption('')
      await waitUntil(
        async () => (await rows()).length === allRows,
        `${name} clearing the preparation filter must restore the list`
      )

      // The Execution filter must offer every state the contract declares, including the
      // two that are not part of the happy path. Otherwise an operator cannot isolate an
      // unconfirmed submission or a run whose execution was skipped.
      const execution = page.getByLabel('Execution')
      const executionStates = await execution
        .locator('option')
        .evaluateAll((options) => options.map((option) => option.value))
      assert.ok(
        executionStates.includes('uncertain') &&
          executionStates.includes('skipped'),
        `${name} the Execution filter must include uncertain and skipped`
      )
      await execution.selectOption('uncertain')
      await waitUntil(
        async () => (await rows()).length < allRows,
        `${name} the uncertain execution state must narrow the list`
      )
      await execution.selectOption('')
      await waitUntil(
        async () => (await rows()).length === allRows,
        `${name} clearing the execution filter must restore the list`
      )

      const firstPage = await rows()
      assert.ok(
        await previous.isDisabled(),
        `${name} first page must disable the previous control`
      )
      assert.ok(
        !(await next.isDisabled()),
        `${name} first page must offer a next page`
      )

      await next.click()
      await waitUntil(async () => {
        const pageIds = await rows()
        return (
          pageIds.length > 0 &&
          pageIds.every((runId) => !firstPage.includes(runId))
        )
      }, `${name} next page must not repeat the first page`)
      const secondPage = await rows()
      assert.ok(secondPage.length > 0, `${name} next page must return runs`)
      assert.ok(
        !(await previous.isDisabled()),
        `${name} a later page must enable the previous control`
      )

      // The API only pages forward, so returning has to reuse the remembered
      // cursor rather than silently sending the reader back to the first page.
      await previous.click()
      await waitUntil(
        async () => JSON.stringify(await rows()) === JSON.stringify(firstPage),
        `${name} previous page must restore the first page`
      )

      await page.goto(`${base}/runs`, { waitUntil: 'networkidle' })
      await page.getByRole('heading', { name: 'Runs' }).waitFor()

      // The jump box is the only way to navigate by identity: the read API cannot
      // filter by run id, and the list shows only an abbreviation of it.
      await page.locator('tbody tr:first-child td a').first().click()
      await page.waitForSelector('.run-progress-timeline')
      const knownRunId =
        (await page.locator('.run-id').first().textContent())?.trim() ?? ''
      assert.ok(
        knownRunId.length > 0,
        `${name} the detail page must show the full run id`
      )
      await page.getByRole('link', { name: 'Back to runs' }).click()
      await page.getByRole('heading', { name: 'Runs' }).waitFor()

      const jump = page.getByLabel('Go to run ID')
      await jump.fill(knownRunId)
      await page.getByRole('button', { name: 'Go to run' }).click()
      await page.waitForSelector('.run-progress-timeline')
      assert.strictEqual(
        (await page.locator('.run-id').first().textContent())?.trim(),
        knownRunId,
        `${name} the jump box must open the given run`
      )

      // Jumping to an unknown id from a detail page must not keep rendering the previous
      // run. React Router keeps this component mounted when only the id changes, so that
      // state has to be keyed by id or the 404 reads as a failed refresh of the old run.
      await jump.fill('00000000-0000-0000-0000-000000000000')
      await page.getByRole('button', { name: 'Go to run' }).click()
      await page.getByRole('heading', { name: 'Run not found' }).waitFor({
        state: 'visible'
      })
      assert.strictEqual(
        await page.getByText('Unable to load Review Runs').count(),
        0,
        `${name} an unknown run id must not show the generic error page`
      )
      assert.strictEqual(
        await page.getByText('Refresh failed').count(),
        0,
        `${name} an unknown run id must not read as a failed refresh`
      )
      assert.strictEqual(
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
      // Wait until the filters have been applied to the list, so the first row we open is
      // actually a published repository review rather than a stale row.
      //
      // Both filters have to be observed: the workflow alone is not evidence that the request
      // came back. The unfiltered list already has a `repository-review` run at the top (an
      // active one), so waiting on the workflow column alone passes against the list rendered
      // before the filters were ever applied - and the run this test then opens has no
      // publication start to show. Read the publication cell of that same row instead, which
      // only says `Published` once the filtered response is on screen.
      await waitUntil(async () => {
        const firstRow = page.locator('tbody tr:first-child')
        if ((await firstRow.count()) === 0) return false
        const workflowCell = (
          (await firstRow.locator('td:nth-child(2)').textContent()) ?? ''
        ).trim()
        const publicationCell = (
          (await firstRow.locator('td:nth-child(5)').textContent()) ?? ''
        ).trim()
        return (
          workflowCell === 'Repository review' &&
          publicationCell.includes('Published')
        )
      }, `${name} the repository-review and published filters must both apply to the list`)
      await page.locator('tbody tr:first-child td a').first().click()
      await page.waitForSelector('.run-progress-timeline')
      const publicationBody =
        (await page
          .locator('.run-progress-timeline .mantine-Timeline-itemBody')
          .nth(3)
          .textContent()) ?? ''
      if (!/took/.test(publicationBody)) {
        // The publication phase renders its timestamp and elapsed time only when
        // `publication.started_at` is set, so an empty body means the run the list led us to
        // had no start for that phase. That is either the fixtures losing a timestamp or the
        // list leading somewhere other than the filtered row; the two are indistinguishable
        // from the rendered text alone, so report both: what was on screen, and what the
        // server says about the run the page opened.
        const runId = decodeURIComponent(new URL(page.url()).pathname)
          .split('/')
          .pop()
        const served = await page.evaluate(async (id) => {
          const response = await fetch(`/api/runs/${encodeURIComponent(id)}`)
          if (!response.ok) return { status: response.status }
          const { run } = await response.json()
          return {
            status: response.status,
            workflow: run.workflow,
            publication: run.publication,
            execution: run.execution,
            preparation_status: run.preparation?.status
          }
        }, runId)
        assert.fail(
          `${name} a finished phase must read as a duration: opened ${runId}, timeline ` +
            `body ${JSON.stringify(publicationBody)}, server ${JSON.stringify(served)}`
        )
      }
      // The artifact reads as one row with the download trailing. Compare centres, not
      // tops: the facts use different font sizes, so their tops differ on the same line.
      const artifact = await page.evaluate(() => {
        const row = document.querySelector('.artifact-row')
        if (row === null) return { found: false }
        const download = row.querySelector('a[download]')
        const facts = [...row.querySelectorAll('.artifact-facts > *')].map(
          (element) => element.getBoundingClientRect()
        )
        const centres = facts.map((box) => Math.round(box.y + box.height / 2))
        return {
          found: true,
          facts: facts.length,
          sameLine: new Set(centres).size === 1,
          downloadTrails:
            download !== null &&
            Math.abs(
              download.getBoundingClientRect().right -
                row.getBoundingClientRect().right
            ) < 2
        }
      })
      assert.ok(artifact.found, `${name} a stored artifact must render`)
      assert.strictEqual(
        artifact.facts,
        3,
        `${name} the artifact must show size, type and digest`
      )
      // The facts wrap on a narrow screen by design, so only the wide layout promises
      // a single line; the trailing download is promised everywhere.
      if (viewport.width >= 768) {
        assert.ok(
          artifact.sameLine,
          `${name} the artifact facts must share one line`
        )
      }
      assert.ok(
        artifact.downloadTrails,
        `${name} the download must trail the artifact row`
      )
      // Both blocks lead with a status badge, and the artifact's own storage state was
      // never shown anywhere before, so losing it would be silent.
      assert.strictEqual(
        await page.locator('.artifact-row > .mantine-Badge-root').count(),
        1,
        `${name} the artifact row must lead with its status badge`
      )

      // Content must not touch the line above it. Both the execution timestamp and the
      // publication summary have crowded their block before, so measure the gap.
      const breathing = await page.evaluate(() => {
        const stamp = [
          ...document.querySelectorAll('.mantine-Timeline-itemBody p')
        ].find((p) => p.textContent.includes('\u00b7 took'))
        const row = document.querySelector('.artifact-row')
        const summary = document.querySelector('.publication-summary p')
        const firstStep = document.querySelector('.delivery-item')
        const gap = (above, below) =>
          above === null || below === null
            ? null
            : Math.round(
                below.getBoundingClientRect().top -
                  above.getBoundingClientRect().bottom
              )
        return {
          artifact: gap(stamp ?? null, row),
          publication: gap(summary ?? null, firstStep)
        }
      })
      for (const [label, value] of Object.entries(breathing)) {
        assert.ok(
          value === null || value >= 8,
          `${name} the ${label} block must not touch the line above it (saw ${value})`
        )
      }

      // The digest is abbreviated until asked for; nothing covered that toggle before.
      const digest = page.locator('.artifact-digest-toggle')
      assert.strictEqual(
        await digest.getAttribute('aria-expanded'),
        'false',
        `${name} digest starts short`
      )
      const collapsed = (await digest.textContent()) ?? ''
      await digest.click()
      assert.strictEqual(
        await digest.getAttribute('aria-expanded'),
        'true',
        `${name} digest must expand`
      )
      assert.ok(
        ((await digest.textContent()) ?? '').length > collapsed.length,
        `${name} expanding the digest must reveal more of it`
      )

      // A step reads as one row where there is width: its key beside its status and its exit
      // trailing. Narrow screens deliberately stack the identity instead, so assert the
      // shape that applies rather than assuming the wide one. The browser returns numbers
      // only; the browser callback cannot see anything from this side.
      const stacked = await page.$eval(
        '.delivery-main',
        (element) => getComputedStyle(element).flexDirection === 'column'
      )
      const stepLayout = await page.$$eval('.delivery-item', (items) =>
        items.map((item) => {
          const badge = item
            .querySelector('.mantine-Badge-root')
            ?.getBoundingClientRect()
          const key = item
            .querySelector('.delivery-step-key')
            ?.getBoundingClientRect()
          const link = item
            .querySelector('.delivery-link')
            ?.getBoundingClientRect()
          return {
            badgeY: badge?.y ?? null,
            keyY: key?.y ?? null,
            keyRight: key?.right ?? null,
            linkLeft: link?.left ?? null
          }
        })
      )
      assert.ok(
        stepLayout.length > 0,
        `${name} the published run must list its steps`
      )
      for (const step of stepLayout) {
        if (step.badgeY !== null && step.keyY !== null) {
          if (stacked) {
            assert.ok(
              step.keyY > step.badgeY,
              `${name} a stacked step must read status then key`
            )
          } else {
            assert.ok(
              Math.abs(step.badgeY - step.keyY) < 6,
              `${name} a step key must sit beside its status`
            )
          }
        }
        if (!stacked && step.linkLeft !== null && step.keyRight !== null) {
          assert.ok(
            step.linkLeft > step.keyRight,
            `${name} a step link must trail its row`
          )
        }
      }

      const deliverySteps = await page.locator('.delivery-item').count()
      assert.ok(
        deliverySteps > 1,
        `${name} a published repository review must show its steps (saw ${deliverySteps})`
      )

      // A run with a single result uses the same row shape as one with several: identity
      // on the left, exit trailing. Sharing the timestamp's line was the thing to avoid.
      // Both filters are set in one navigation: the selects drive the URL, so driving them
      // back to back can drop one and quietly select a different run.
      await page.goto(
        `${base}/runs?workflow=issue-review&publication_status=published`,
        {
          waitUntil: 'networkidle'
        }
      )
      await page.getByRole('heading', { name: 'Runs' }).waitFor()
      await page.locator('tbody tr:first-child td a').first().waitFor()
      await page.locator('tbody tr:first-child td a').first().click()
      await page.waitForSelector('.delivery-item')
      // This case asserts an absence: the summary must not carry the exit link.
      // There is no event to wait on for "does not appear", so keep a short settle
      // window and then check the count.
      await page.waitForTimeout(300)
      assert.strictEqual(
        await page.locator('.publication-summary .delivery-link').count(),
        0,
        `${name} the summary must not carry the exit link`
      )
      const single = await page.evaluate(() => {
        const item = document.querySelector('.delivery-item')
        if (item === null) return { found: false }
        const key = item
          .querySelector('.delivery-step-key')
          ?.getBoundingClientRect()
        const link = item
          .querySelector('.delivery-link')
          ?.getBoundingClientRect()
        return {
          found: true,
          badge: item.querySelector('.mantine-Badge-root') !== null,
          key: item.querySelector('.delivery-step-key') !== null,
          trailing:
            link !== undefined && key !== undefined && link.left > key.right
        }
      })
      assert.ok(
        single.found && single.badge && single.key,
        `${name} a single result needs its row`
      )
      assert.ok(
        single.found && single.trailing,
        `${name} a single exit must trail its row`
      )
      await page.goto(`${base}/runs`, { waitUntil: 'networkidle' })
      await page.getByRole('heading', { name: 'Runs' }).waitFor()
    }

    // The newest fixture run may still be preparing, whose Execution phase shows a status
    // rather than an elapsed time. Filter to a run that has actually been submitted so the
    // timing assertions below are about a phase that has begun.
    await page.getByLabel('Execution').selectOption('running')
    // Wait for the filter to actually apply: a stale row from before the selection would
    // otherwise be clicked, and a still-preparing run has no Execution timestamp to assert.
    await waitUntil(
      async () =>
        (
          (await page
            .locator('tbody tr:first-child td:nth-child(4)')
            .textContent?.()) ?? ''
        ).trim() === 'Running',
      `${name} the Execution filter must apply before opening a run`
    )
    await page.locator('tbody tr:first-child td a').first().click()
    await page.waitForSelector('.run-progress-timeline', { timeout: 10_000 })
    const knownRunIdForCopy =
      (await page.locator('.run-id').first().textContent())?.trim() ?? ''
    const steps = await page.$$eval(
      '.run-progress-timeline .mantine-Timeline-item',
      (items) =>
        items.map((item) => ({
          title:
            item
              .querySelector('.mantine-Timeline-itemTitle')
              ?.textContent?.trim() ?? '',
          body:
            item
              .querySelector('.mantine-Timeline-itemBody')
              ?.textContent?.trim() ?? ''
        }))
    )
    assert.deepStrictEqual(
      steps.map((step) => step.title),
      ['Created', 'Preparation', 'Execution', 'Publication'],
      `${name} timeline steps changed`
    )
    // Created, Preparation, and Execution always carry their timestamp. Publication carries one
    // only once the publication actually started: before then the field it would
    // read is the publication row's creation time at admission, which is how a
    // `pending` run used to render a publication timestamp earlier than Execution.
    // 24-hour on purpose: en-US and zh-CN disagreed by default (AM/PM versus 24-hour), so the
    // same instant read differently depending on the console language. The console now pins
    // `hour12: false` for both, and this assertion is what keeps that from regressing.
    const TIMESTAMP = /\d{1,2}\/\d{1,2}\/\d{4}, \d{2}:\d{2}:\d{2}/
    const [created, preparation, execution, publication] = steps
    assert.match(
      created.body,
      TIMESTAMP,
      `${name} "Created" must show a timestamp`
    )
    assert.match(
      preparation.body,
      TIMESTAMP,
      `${name} "Preparation" must show a timestamp`
    )
    assert.match(
      execution.body,
      TIMESTAMP,
      `${name} "Execution" must show a timestamp`
    )
    assert.doesNotMatch(
      publication.body,
      TIMESTAMP,
      `${name} a publication that has not started must show no timestamp`
    )

    // Each phase reports how long it took, and the id is copyable without selecting it
    // by hand — the console is the only place that knows the id.
    assert.match(
      execution.body,
      /\d+[dhms]/,
      `${name} the Execution phase must report its elapsed time`
    )
    assert.match(
      execution.body,
      /so far/,
      `${name} an in-flight phase must read as still running`
    )
    // Preparation is timed from its own start to its own end, not from a row mtime: a run whose
    // preparation has finished must therefore report a duration, and a run still preparing must
    // read as in flight rather than showing an end it does not have.
    assert.match(
      preparation.body,
      /\d+[dhms]/,
      `${name} the Preparation phase must report its elapsed time`
    )
    assert.ok(
      /(took|so far)/.test(preparation.body),
      `${name} the Preparation phase must read as either finished or in flight`
    )
    await page.getByRole('button', { name: 'Copy run ID' }).click()
    await waitUntil(
      async () =>
        (await page.evaluate(() => navigator.clipboard.readText())) ===
        knownRunIdForCopy,
      `${name} the copy button must put the full run id on the clipboard`
    )

    // The general form of the same bug: a timeline may not run backwards.
    const instants = [created, preparation, execution, publication]
      .map((step) => TIMESTAMP.exec(step.body)?.[0])
      .filter((text) => text !== undefined)
      .map((text) => Date.parse(text))
    for (let index = 1; index < instants.length; index += 1) {
      assert.ok(
        instants[index] >= instants[index - 1],
        `${name} timeline timestamps must not go backwards`
      )
    }
    assert.strictEqual(
      await page.locator('.run-progress-timeline .status-text').count(),
      0,
      `${name} timeline must not repeat status words`
    )

    // Guard for the Mantine coupling described in styles.css: the rail is painted
    // from Timeline.Item::before and inherits the bullet colour, so a Mantine change
    // would silently revert it to the status colour or a solid line.
    const rail = await page.evaluate(() => {
      const item = document.querySelector(
        '.run-progress-timeline .mantine-Timeline-item'
      )
      if (item === null) return null
      const before = getComputedStyle(item, '::before')
      const bullet = item.querySelector('.mantine-Timeline-itemBullet')
      return {
        display: before.display,
        style: before.borderLeftStyle,
        color: before.borderLeftColor,
        bulletColor:
          bullet === null ? null : getComputedStyle(bullet).backgroundColor
      }
    })
    assert.notStrictEqual(rail, null, `${name} timeline item missing`)
    if (rail !== null && rail.display !== 'none') {
      assert.strictEqual(
        rail.style,
        'dashed',
        `${name} timeline rail must stay dashed`
      )
      assert.notStrictEqual(
        rail.color,
        rail.bulletColor,
        `${name} timeline rail must not reuse the status colour`
      )
    }

    // A publication that was ruled out is not a moment either, so it must stay
    // silent rather than repeat the Execution failure time.
    await page.goto(`${base}/runs`, { waitUntil: 'networkidle' })
    await page.getByLabel('Execution').selectOption('failed')
    await waitUntil(
      async () =>
        /[A-Z_]{4,}/.test(
          (await page
            .locator('tbody tr:first-child td')
            .last()
            .textContent()) ?? ''
        ),
      `${name} a failed row must show its failure code in the list`
    )
    await page.locator('tbody tr:first-child td a').first().click()
    await page.waitForSelector('.run-progress-timeline', { timeout: 10_000 })
    const ruledOut = await page.$$eval(
      '.run-progress-timeline .mantine-Timeline-item',
      (items) =>
        items.map(
          (item) =>
            item.querySelector('.mantine-Timeline-itemBody')?.textContent ?? ''
        )
    )
    assert.strictEqual(ruledOut.length, 4, `${name} ruled-out timeline changed`)
    assert.doesNotMatch(
      ruledOut[3],
      TIMESTAMP,
      `${name} a ruled-out publication must show no timestamp`
    )

    // An expired session is not a refresh blip: it must reach the sign-in form even when
    // the console already has data, otherwise nothing can update and nothing says why.
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
    // A 401 must return the reader to the sign-in form.
    await page.getByLabel('Access token').waitFor({ state: 'visible' })
    await page.unroute('**/api/runs*')

    // A specific backend failure must not collapse into the generic sentence.
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
        /unreachable/.test(
          (await page.locator('[role="alert"]').first().textContent()) ?? ''
        ),
      `${name} an unreachable Review Runs must say so`
    )
    await page.unroute('**/api/runs*')

    // A touch device never hovers, so the action has to remain visible there.
    const touchContext = await browser.newContext({
      viewport,
      locale: 'en-US',
      hasTouch: true
    })
    const touchPage = await touchContext.newPage()
    await touchPage.goto(`${base}/runs`, { waitUntil: 'networkidle' })
    await touchPage.getByRole('heading', { name: 'Runs' }).waitFor()
    await waitUntil(
      async () =>
        (await touchPage
          .locator('tbody tr:first-child .row-action')
          .evaluate((element) => getComputedStyle(element).opacity)) === '1',
      `${name} a touch device must see the row action without hovering`
    )
    await touchContext.close()

    // Both colour schemes must stay readable. Contrast is an invariant; exact pixels
    // are not, so this is the part of the visual layer worth asserting.
    for (const theme of ['light', 'dark']) {
      const themeContext = await browser.newContext({
        viewport,
        locale: 'en-US'
      })
      const themePage = await themeContext.newPage()
      await themePage.addInitScript(
        (value) => localStorage.setItem('ui-theme', value),
        theme
      )
      await themePage.goto(`${base}/runs`, { waitUntil: 'networkidle' })
      await themePage.getByRole('heading', { name: 'Runs' }).waitFor()
      const contrast = await waitUntilValue(
        () => themePage.evaluate(CONTRAST),
        (value) =>
          Number.isFinite(value.title) &&
          value.title >= 4.5 &&
          Number.isFinite(value.cell) &&
          value.cell >= 4.5,
        `${name} the ${theme} theme must render a readable contrast`
      )
      const dark = theme === 'dark'
      assert.strictEqual(
        contrast.background.r < 128,
        dark,
        `${name} the ${theme} theme must render its own background`
      )
      assert.ok(
        contrast.title >= 4.5 && contrast.cell >= 4.5,
        `${name} ${theme} theme contrast is too low (title ${contrast.title}, cell ${contrast.cell})`
      )
      await themeContext.close()
    }

    const manualContext = await browser.newContext({
      viewport,
      locale: 'en-US'
    })
    const manualPage = await manualContext.newPage()
    await manualPage.addInitScript(() =>
      localStorage.setItem('ui-auto-refresh', 'false')
    )
    await manualPage.goto(`${base}/runs?execution_status=running`, {
      waitUntil: 'networkidle'
    })
    await manualPage.getByRole('heading', { name: 'Runs' }).waitFor()
    await manualPage.locator('tbody tr:first-child td a').first().click()
    await manualPage.waitForSelector('.run-progress-timeline')
    const readElapsed = () =>
      manualPage
        .locator('.run-progress-timeline .mantine-Timeline-itemBody')
        .nth(2)
        .textContent()
    await waitUntil(
      async () => /so far/.test((await readElapsed()) ?? ''),
      `${name} an in-flight phase must read as still running`
    )
    const elapsedBefore = await readElapsed()
    assert.match(
      elapsedBefore ?? '',
      /so far/,
      `${name} an in-flight phase must read as still running`
    )
    await manualPage.waitForTimeout(13_000)
    const elapsedAfter = await readElapsed()
    // The console re-renders the elapsed value from a local clock while the run is active.
    // Once the duration is shown at hour granularity ("9h 19m") a 13-second wait cannot change
    // the text, so only require movement when the value still carries seconds; either way it
    // must stay a live "so far" reading rather than reverting to a static timestamp.
    assert.match(
      elapsedAfter ?? '',
      /so far/,
      `${name} an in-flight phase must stay live after a tick`
    )
    if (/\d+s\b/.test(elapsedBefore ?? ''))
      assert.notStrictEqual(
        elapsedAfter,
        elapsedBefore,
        `${name} an in-flight elapsed time must keep moving without a refetch`
      )
    await manualContext.close()

    // The English pass above cannot catch wording that only went wrong in translation, and
    // both a publication step called "executed" and a marker placed after its value did.
    const zhContext = await browser.newContext({ viewport, locale: 'zh-CN' })
    const zhPage = await zhContext.newPage()
    await zhPage.addInitScript(() => localStorage.setItem('ui-language', 'zh'))
    await zhPage.goto(
      `${base}/runs?workflow=repository-review&publication_status=published`,
      {
        waitUntil: 'networkidle'
      }
    )
    await zhPage.locator('tbody tr:first-child td a').first().waitFor()
    await zhPage.locator('tbody tr:first-child td a').first().click()
    await zhPage.waitForSelector('.run-progress-timeline')
    const zhBadges = await waitUntilValue(
      () =>
        zhPage.$$eval('.delivery-item .mantine-Badge-root', (items) =>
          items.map((item) => item.textContent?.trim())
        ),
      (badges) => badges.length > 0,
      `${name} the zh run must show its publication steps`
    )
    assert.ok(
      zhBadges.length > 0,
      `${name} the zh run must show its publication steps`
    )
    for (const badge of zhBadges) {
      assert.strictEqual(
        badge,
        '发布成功',
        `${name} a publication step must not be described with execution wording`
      )
    }
    // A run that has actually been submitted, so its Execution phase is timed (a still
    // preparing run would show a status and never the "已持续" marker this checks).
    await zhPage.goto(`${base}/runs?execution_status=running`, {
      waitUntil: 'networkidle'
    })
    await zhPage.getByRole('heading', { name: 'Runs' }).waitFor()
    await zhPage.locator('tbody tr:first-child td a').first().click()
    await zhPage.waitForSelector('.run-progress-timeline')
    const zhExecution = await waitUntilValue(
      () =>
        zhPage
          .locator('.run-progress-timeline .mantine-Timeline-itemBody')
          .nth(2)
          .textContent(),
      (text) => text !== null && text.length > 0,
      `${name} the zh run must render its execution phase`
    )
    assert.match(
      zhExecution ?? '',
      /· 已持续 /,
      `${name} the Chinese marker must precede the elapsed value`
    )
    await zhContext.close()

    console.log(`browser-smoke ${name}: ok (${base})`)
    await context.close()
  }
} finally {
  await browser.close()
  if (server !== undefined) await server.close()
}
