import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

import { expect, openAuthenticatedRuns, test } from './fixtures.js'

type AxeViolation = Readonly<{
  id: string
  impact: string | null | undefined
  help: string
  targets: unknown[]
}>

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  const violations: AxeViolation[] = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.map((node) => node.target)
  }))

  expect(violations).toEqual([])
}

test.beforeEach(async ({ fixtureRuntime }) => {
  test.skip(
    fixtureRuntime.server === undefined,
    'Accessibility baselines require the stable local fixture data.'
  )
})

test('runs list has no detectable WCAG A/AA violations', async ({ page }) => {
  await openAuthenticatedRuns(page)
  await expectNoAccessibilityViolations(page)
})

test('run detail has no detectable WCAG A/AA violations', async ({ page }) => {
  await openAuthenticatedRuns(page)
  await page.locator('tbody tr:first-child td a').first().click()
  await page.locator('.run-progress-timeline').waitFor()
  await expectNoAccessibilityViolations(page)
})

test('memory workspace has no detectable WCAG A/AA violations', async ({
  page
}) => {
  await openAuthenticatedRuns(page)
  await page.goto('/memory', { waitUntil: 'networkidle' })
  await page.locator('main').waitFor()
  await expectNoAccessibilityViolations(page)
})

test('memory graph toolbar and nodes have no detectable WCAG A/AA violations', async ({
  page
}) => {
  await openAuthenticatedRuns(page)
  await page.goto('/memory', { waitUntil: 'networkidle' })
  await page.getByRole('tab', { name: 'Revisions' }).click()
  await page.locator('.revision-graph-node[data-current]').waitFor()
  await expectNoAccessibilityViolations(page)
})

test('memory loading state has no detectable WCAG A/AA violations', async ({
  page
}) => {
  await openAuthenticatedRuns(page)
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/memory/overview?*', async (route) => {
    await ready
    await route.continue()
  })
  try {
    await page.goto('/memory', { waitUntil: 'domcontentloaded' })
    await page
      .getByRole('status')
      .filter({ hasText: 'Loading…' })
      .first()
      .waitFor()
    await expectNoAccessibilityViolations(page)
  } finally {
    release()
  }
})

test('trajectory viewer has no detectable WCAG A/AA violations', async ({
  page
}) => {
  await openAuthenticatedRuns(page)
  await page.goto('/viewer', { waitUntil: 'networkidle' })
  await page.locator('main').waitFor()
  await expectNoAccessibilityViolations(page)
})

test('stable error state has no detectable WCAG A/AA violations', async ({
  page
}) => {
  await openAuthenticatedRuns(page)
  await page.goto('/runs/fixture-artifact-load-error/files', {
    waitUntil: 'networkidle'
  })
  await page
    .getByText('The run files could not be opened.', { exact: true })
    .waitFor()
  await expectNoAccessibilityViolations(page)
})

test('populated memory files and observations keep readable text', async ({
  page
}) => {
  await page.goto('/memory/revisions/2/tree', { waitUntil: 'networkidle' })
  await expect(page.locator('.memory-markdown')).toBeVisible()
  await expectNoAccessibilityViolations(page)
  await page.goto('/memory', { waitUntil: 'networkidle' })
  await page.getByRole('tab', { name: 'Observations', exact: true }).click()
  await expect(page.locator('.memory-table tbody tr').first()).toBeVisible()
  await expectNoAccessibilityViolations(page)
})

test('loaded trajectory tool calls keep readable text', async ({ page }) => {
  await page.goto('/viewer', { waitUntil: 'networkidle' })
  await page.getByRole('textbox').fill(
    JSON.stringify({
      seq: 1,
      event: 'message',
      message: {
        id: 'assistant',
        role: 'assistant',
        content: 'Inspect this file.',
        tool_calls: [
          { id: 'call', name: 'read_file', args: { path: 'MEMORY.md' } }
        ]
      }
    })
  )
  await page.getByRole('button', { name: 'Render', exact: true }).click()
  await expect(page.locator('.trajectory-tool-call')).toBeVisible()
  await expectNoAccessibilityViolations(page)
})
