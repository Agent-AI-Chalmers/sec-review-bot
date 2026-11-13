import { expect, test } from './fixtures.js'

test('viewer investigation survives navigation but clear and reload remove it', async ({
  page
}) => {
  await page.goto('/viewer', { waitUntil: 'networkidle' })
  const input = Array.from({ length: 24 }, (_, index) =>
    JSON.stringify({
      seq: index + 1,
      event: 'message',
      message: {
        id: `m${index}`,
        role: index === 0 ? 'system' : 'assistant',
        content: `Investigation ${index}\n\n${'Evidence from the file. '.repeat(20)}`
      }
    })
  ).join('\n')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'investigation.jsonl',
    mimeType: 'text/plain',
    buffer: Buffer.from(input)
  })
  // Use the current translated placeholder rather than a CSS input position.
  const trajectorySearch = page.getByPlaceholder(
    'Search messages, tools, and arguments'
  )
  await expect(page.locator('.trajectory-timeline')).toBeVisible()
  await trajectorySearch.fill('Investigation')
  await page.getByRole('checkbox', { name: 'System', exact: true }).uncheck()
  await page.evaluate(() => window.scrollTo(0, 650))
  const position = await page.evaluate(() => window.scrollY)
  await page.getByRole('link', { name: 'Memory', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Memory', exact: true })
  ).toBeVisible()
  await expect(page.locator('.trajectory-timeline')).toBeHidden()
  await page.getByRole('link', { name: 'Viewer', exact: true }).click()
  await expect(trajectorySearch).toHaveValue('Investigation')
  await expect(
    page.getByRole('checkbox', { name: 'System', exact: true })
  ).not.toBeChecked()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(position)
  await expect(
    page.getByText('investigation.jsonl', { exact: true }).first()
  ).toBeVisible()
  await page.getByRole('button', { name: 'Edit input', exact: true }).click()
  await expect(page.getByLabel('Paste trajectory JSONL')).toHaveValue(input)
  await page.getByRole('button', { name: 'Clear viewer', exact: true }).click()
  await expect(page.getByLabel('Paste trajectory JSONL')).toHaveValue('')
  await expect(page.locator('.trajectory-timeline')).toHaveCount(0)
  await page.getByLabel('Paste trajectory JSONL').fill(input)
  await page.reload()
  await expect(page.getByLabel('Paste trajectory JSONL')).toHaveValue('')
})

test('unrendered viewer drafts survive a round trip', async ({ page }) => {
  await page.goto('/viewer', { waitUntil: 'networkidle' })
  await page.getByLabel('Paste trajectory JSONL').fill('unfinished draft')
  await page.getByRole('link', { name: 'Runs', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Runs', exact: true })
  ).toBeVisible()
  await page.getByRole('link', { name: 'Viewer', exact: true }).click()
  await expect(page.getByLabel('Paste trajectory JSONL')).toHaveValue(
    'unfinished draft'
  )
})
