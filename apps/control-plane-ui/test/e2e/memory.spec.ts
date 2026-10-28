import { expect, test } from './fixtures.js'

test('maintenance control mutates only this worker fixture server', async ({
  page,
  fixtureRuntime
}) => {
  test.skip(
    fixtureRuntime.server === undefined,
    'This state-mutating check is limited to an isolated local fixture server.'
  )

  await page.goto('/memory')

  const control = page.getByRole('switch', {
    name: 'Automatic maintenance'
  })
  await expect(control).toBeChecked()

  await control.click()
  try {
    await expect(control).not.toBeChecked()
  } finally {
    if (!(await control.isChecked())) await control.click()
  }
  await expect(control).toBeChecked()
})
