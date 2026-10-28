import assert from 'node:assert/strict'

async function chooseSelect(page, label, option) {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

export async function runRunsTimelineFlow({ name, page, base, waitUntil }) {
  await page.goto(`${base}/runs`, { waitUntil: 'networkidle' })
  await chooseSelect(page, 'Execution', 'Running')
  await waitUntil(
    async () =>
      (
        (await page
          .locator('tbody tr:first-child td:nth-child(5)')
          .textContent?.()) ?? ''
      ).trim() === 'Running',
    `${name} the Execution filter must apply before opening a run`
  )
  await page.locator('tbody tr:first-child td a').first().click()
  await page.waitForSelector('.run-progress-timeline', { timeout: 10_000 })
  const runId =
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

  const timestamp = /\d{1,2}\/\d{1,2}\/\d{4}, \d{2}:\d{2}:\d{2}/
  const [created, preparation, execution, publication] = steps
  assert.match(created.body, timestamp, `${name} Created must show a timestamp`)
  assert.match(
    preparation.body,
    timestamp,
    `${name} Preparation must show a timestamp`
  )
  assert.match(
    execution.body,
    timestamp,
    `${name} Execution must show a timestamp`
  )
  assert.doesNotMatch(
    publication.body,
    timestamp,
    `${name} a publication that has not started must show no timestamp`
  )
  assert.match(execution.body, /\d+[dhms]/)
  assert.match(execution.body, /so far/)
  assert.match(preparation.body, /\d+[dhms]/)
  assert.ok(/(took|so far)/.test(preparation.body))

  await page.getByRole('button', { name: 'Copy run ID' }).click()
  await waitUntil(
    async () =>
      (await page.evaluate(() => navigator.clipboard.readText())) === runId,
    `${name} the copy button must put the full run id on the clipboard`
  )

  const instants = [created, preparation, execution, publication]
    .map((step) => timestamp.exec(step.body)?.[0])
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

  await page.goto(`${base}/runs`, { waitUntil: 'networkidle' })
  await chooseSelect(page, 'Execution', 'Failed')
  await waitUntil(
    async () =>
      /[A-Z_]{4,}/.test(
        (await page.locator('tbody tr:first-child td').last().textContent()) ??
          ''
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
    timestamp,
    `${name} a ruled-out publication must show no timestamp`
  )
}
