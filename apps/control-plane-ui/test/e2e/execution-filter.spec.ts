import { openAuthenticatedRuns, test, expect } from './fixtures.js'

test('execution filter keeps long selected labels and selected options visible', async ({
  page
}) => {
  await openAuthenticatedRuns(page)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const filter = page.getByRole('combobox', { name: 'Execution', exact: true })
  for (const label of ['Disconnected', 'Succeeded']) {
    await filter.click()
    await page.getByRole('option', { name: label, exact: true }).click()
    await expect(filter).toHaveValue(label)
    // Input scrollWidth includes the arrow padding, so measure the actual text area.
    expect(
      await filter.evaluate((element) => {
        const input = element as HTMLInputElement
        const style = getComputedStyle(input)
        const context = document.createElement('canvas').getContext('2d')!
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
        return (
          context.measureText(input.value).width <=
          input.clientWidth -
            parseFloat(style.paddingLeft) -
            parseFloat(style.paddingRight)
        )
      })
    ).toBe(true)
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
  const filter = page.getByRole('combobox', {
    name: 'Execution',
    exact: true
  })
  await filter.click()
  await page.getByRole('option', { name: 'Succeeded', exact: true }).click()
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
