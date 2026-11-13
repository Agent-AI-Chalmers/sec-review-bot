import {
  openAuthenticatedRuns,
  openRunFilters,
  test,
  expect
} from './fixtures.js'

test('execution filter keeps long selected labels and selected options visible', async ({
  page
}) => {
  await openAuthenticatedRuns(page)
  await openRunFilters(page)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const filter = page.getByRole('combobox', { name: 'Execution', exact: true })
  for (const label of ['Disconnected', 'Succeeded']) {
    await filter.click()
    await page.getByRole('option', { name: label, exact: true }).click()
    await expect(filter).toHaveValue(label)
    // Chrome 157 changed input.clientWidth to exclude inline padding.
    // Derive the content box from the border box on both old and new browsers.
    const dimensions = await filter.evaluate((element) => {
      const input = element as HTMLInputElement
      const style = getComputedStyle(input)
      // Measure using DOM layout, including the input's actual font shaping.
      const text = document.createElement('span')
      text.textContent = input.value
      text.style.cssText = 'position:fixed;visibility:hidden;white-space:pre'
      for (const property of [
        'font-family',
        'font-size',
        'font-weight',
        'font-style',
        'font-stretch',
        'font-variation-settings',
        'font-feature-settings',
        'font-optical-sizing',
        'letter-spacing',
        'text-transform'
      ])
        text.style.setProperty(property, style.getPropertyValue(property))
      document.body.append(text)
      const textWidth = text.getBoundingClientRect().width
      text.remove()
      return {
        textWidth,
        availableWidth:
          input.getBoundingClientRect().width -
          parseFloat(style.borderLeftWidth) -
          parseFloat(style.borderRightWidth) -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight),
        borderBoxWidth: input.getBoundingClientRect().width,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        connected: input.isConnected,
        value: input.value
      }
    })
    expect(
      dimensions.textWidth,
      `Selected label geometry: ${JSON.stringify(dimensions)}`
    ).toBeLessThanOrEqual(dimensions.availableWidth)
    await filter.click()
    const selected = page.getByRole('option', { name: label, exact: true })
    await expect(selected).toHaveAttribute('aria-selected', 'true')
    await expect(selected.locator('svg')).toHaveCount(0)
    // Selection stays visible without consuming any label space.
    expect(
      await selected.evaluate((element) => {
        const text = element.querySelector('span')!
        const range = document.createRange()
        range.selectNodeContents(text)
        const bounds = range.getBoundingClientRect()
        const available = text.getBoundingClientRect()
        return (
          bounds.left >= available.left && bounds.right <= available.right + 0.5
        )
      })
    ).toBe(true)
    await page.keyboard.press('Escape')
  }
})

test('selection fill remains distinct from keyboard navigation and hover', async ({
  page
}, testInfo) => {
  // Both themes need coverage; avoid multiplying the same interaction by every device/theme pair.
  const theme = testInfo.project.name === 'mobile' ? 'dark' : 'light'
  await page.addInitScript(
    (value) => localStorage.setItem('ui-theme', value),
    theme
  )
  await openAuthenticatedRuns(page)
  await openRunFilters(page)
  const filter = page.getByRole('combobox', {
    name: 'Execution',
    exact: true
  })
  await filter.click()
  await page.getByRole('option', { name: 'Succeeded', exact: true }).click()
  // Reopen only after the URL-backed value has committed; the next click checks selection styling.
  await expect(page).toHaveURL(
    (url) => url.searchParams.get('execution_status') === 'succeeded'
  )
  await expect(filter).toHaveValue('Succeeded')
  await filter.click()
  const selected = page.getByRole('option', {
    name: 'Succeeded',
    exact: true
  })
  await expect(selected).toHaveAttribute('aria-selected', 'true')
  await expect(selected).toBeVisible()
  const fill = await selected.evaluate((element) => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--brand-soft)'
    element.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  })
  await expect(selected).toHaveCSS('background-color', fill)
  await page.keyboard.press('ArrowDown')
  const active = page.locator('[role="option"][data-combobox-selected]')
  await expect(active).not.toHaveAttribute('aria-selected', 'true')
  await expect(selected).toHaveAttribute('aria-selected', 'true')
  expect(
    await selected.evaluate(
      (element) => getComputedStyle(element).backgroundColor
    )
  ).toBe(fill)
  expect(
    await active.evaluate(
      (element) => getComputedStyle(element).backgroundColor
    )
  ).not.toBe(fill)
  expect(
    await active.evaluate((element) => getComputedStyle(element).outlineStyle)
  ).toBe('solid')
  await selected.hover()
  expect(
    await selected.evaluate(
      (element) => getComputedStyle(element).backgroundColor
    )
  ).toBe(fill)
  expect(
    await selected.evaluate((element) => getComputedStyle(element).outlineStyle)
  ).toBe('solid')
})
