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
