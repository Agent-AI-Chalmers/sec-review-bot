import assert from 'node:assert/strict'

async function readContrast(page) {
  return page.evaluate(() => {
    const parseColour = (value) => {
      const match = value.match(/rgba?\(([^)]+)\)/)
      if (match === null) return null
      const [r, g, b, a = 1] = match[1]
        .split(',')
        .map((part) => Number.parseFloat(part))
      return { r, g, b, a }
    }
    const luminance = ({ r, g, b }) => {
      const channel = (value) => {
        const scaled = value / 255
        return scaled <= 0.03928
          ? scaled / 12.92
          : Math.pow((scaled + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }
    const background = (element) => {
      for (let node = element; node !== null; node = node.parentElement) {
        const colour = parseColour(getComputedStyle(node).backgroundColor)
        if (colour !== null && colour.a > 0.9) return colour
      }
      return { r: 255, g: 255, b: 255, a: 1 }
    }
    const ratio = (element) => {
      if (element === null) return null
      const foreground = parseColour(getComputedStyle(element).color)
      if (foreground === null) return null
      const foregroundLuminance = luminance(foreground)
      const backgroundLuminance = luminance(background(element))
      return (
        Math.round(
          ((Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
            (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)) *
            100
        ) / 100
      )
    }
    return {
      background: background(document.body),
      title: ratio(document.querySelector('h1')),
      cell: ratio(document.querySelector('tbody td span'))
    }
  })
}

export async function runRunsInputAndThemeChecks({
  name,
  viewport,
  browser,
  base,
  storageState,
  waitUntil,
  waitUntilValue
}) {
  const touchContext = await browser.newContext({
    viewport,
    locale: 'en-US',
    storageState,
    hasTouch: true
  })
  try {
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
  } finally {
    await touchContext.close()
  }

  for (const theme of ['light', 'dark']) {
    const themeContext = await browser.newContext({
      viewport,
      locale: 'en-US',
      storageState
    })
    try {
      const themePage = await themeContext.newPage()
      await themePage.addInitScript(
        (value) => localStorage.setItem('ui-theme', value),
        theme
      )
      await themePage.goto(`${base}/runs`, { waitUntil: 'networkidle' })
      await themePage.getByRole('heading', { name: 'Runs' }).waitFor()
      const contrast = await waitUntilValue(
        () => readContrast(themePage),
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
    } finally {
      await themeContext.close()
    }
  }
}

export async function runRunsClockCheck({
  name,
  viewport,
  browser,
  base,
  storageState,
  waitUntil
}) {
  const context = await browser.newContext({
    viewport,
    locale: 'en-US',
    storageState
  })
  try {
    const page = await context.newPage()
    await page.clock.install()
    await page.addInitScript(() =>
      localStorage.setItem('ui-auto-refresh', 'false')
    )
    await page.goto(`${base}/runs?execution_status=running`, {
      waitUntil: 'networkidle'
    })
    await page.getByRole('heading', { name: 'Runs' }).waitFor()
    await page.locator('tbody tr:first-child td a').first().click()
    await page.waitForSelector('.run-progress-timeline')
    const readElapsed = () =>
      page
        .locator('.run-progress-timeline .mantine-Timeline-itemBody')
        .nth(2)
        .textContent()
    await waitUntil(
      async () => /so far/.test((await readElapsed()) ?? ''),
      `${name} an in-flight phase must read as still running`
    )
    const elapsedBefore = await readElapsed()
    assert.match(elapsedBefore ?? '', /so far/)
    await page.clock.fastForward(11_000)
    const elapsedAfter = await readElapsed()
    assert.match(elapsedAfter ?? '', /so far/)
    if (/\d+s\b/.test(elapsedBefore ?? '')) {
      assert.notStrictEqual(
        elapsedAfter,
        elapsedBefore,
        `${name} an in-flight elapsed time must keep moving without a refetch`
      )
    }
  } finally {
    await context.close()
  }
}

export async function runRunsChineseCheck({
  name,
  viewport,
  browser,
  base,
  storageState,
  waitUntilValue
}) {
  const context = await browser.newContext({
    viewport,
    locale: 'zh-CN',
    storageState
  })
  try {
    const page = await context.newPage()
    await page.addInitScript(() => localStorage.setItem('ui-language', 'zh'))
    await page.goto(
      `${base}/runs?workflow=repository-review&publication_status=published`,
      { waitUntil: 'networkidle' }
    )
    await page.locator('tbody tr:first-child td a').first().click()
    await page.waitForSelector('.run-progress-timeline')
    const badges = await waitUntilValue(
      () =>
        page.$$eval('.delivery-item .mantine-Badge-root', (items) =>
          items.map((item) => item.textContent?.trim())
        ),
      (values) => values.length > 0,
      `${name} the zh run must show its publication steps`
    )
    for (const badge of badges) {
      assert.strictEqual(
        badge,
        '发布成功',
        `${name} a publication step must not use execution wording`
      )
    }

    await page.goto(`${base}/runs?execution_status=running`, {
      waitUntil: 'networkidle'
    })
    await page.getByRole('heading', { name: '运行' }).waitFor()
    await page.locator('tbody tr:first-child td a').first().click()
    await page.waitForSelector('.run-progress-timeline')
    const execution = await waitUntilValue(
      () =>
        page
          .locator('.run-progress-timeline .mantine-Timeline-itemBody')
          .nth(2)
          .textContent(),
      (text) => text !== null && text.length > 0,
      `${name} the zh run must render its execution phase`
    )
    assert.match(
      execution ?? '',
      /· 已持续 /,
      `${name} the Chinese marker must precede the elapsed value`
    )
  } finally {
    await context.close()
  }
}
