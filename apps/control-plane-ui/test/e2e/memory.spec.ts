import { expect, test } from './fixtures.js'

test('long editor lines wrap within a narrow memory workspace', async ({
  page,
  fixtureRuntime
}) => {
  test.skip(
    fixtureRuntime.server === undefined,
    'Editing checks require an isolated local memory fixture.'
  )
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto('/memory')
  await page.getByRole('button', { name: 'Edit current memory', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit memory files' })
  const editor = dialog.getByRole('textbox', { name: 'Workspace editor' })
  const content = 'A repository-specific observation. '.repeat(20)
  await editor.fill(content)
  await expect(editor).toHaveText(content)
  await expect(editor.locator('.cm-line')).toHaveCount(1)

  // A single logical line must occupy multiple visual lines without overflowing.
  await expect
    .poll(() => editor.locator('.cm-line').evaluate((line) => line.getBoundingClientRect().height))
    .toBeGreaterThan(40)
  await expect
    .poll(() => editor.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1)
})

test('memory-tree automation mutates only this test fixture server', async ({
  page,
  fixtureRuntime
}) => {
  test.skip(
    fixtureRuntime.server === undefined,
    'This state-mutating check is limited to an isolated local fixture server.'
  )

  await page.goto('/memory')

  const control = page.getByRole('switch', {
    name: 'Auto-update'
  })
  await expect(control).toBeChecked()

  await control.click()
  try {
    await expect(control).not.toBeChecked()
  } finally {
    if (!(await control.isChecked())) {
      await control.click()
    }
  }
  await expect(control).toBeChecked()
})
