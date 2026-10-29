import AxeBuilder from '@axe-core/playwright'
import type { Page, TestInfo } from '@playwright/test'

import { expect, openAuthenticatedRuns, test } from './fixtures.js'

type AxeViolation = Readonly<{
  id: string
  impact: string | null | undefined
  help: string
  targets: unknown[]
}>

async function expectNoAccessibilityViolations(
  page: Page,
  testInfo: TestInfo
): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  const violations: AxeViolation[] = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.map((node) => node.target)
  }))

  const contrast = violations.filter(
    (violation) => violation.id === 'color-contrast'
  )
  // The first axe rollout blocks broken structure and ARIA. Existing contrast
  // problems stay visible in the report without turning this initial baseline red.
  if (contrast.length > 0) {
    await testInfo.attach('axe-color-contrast-report', {
      body: JSON.stringify(contrast, null, 2),
      contentType: 'application/json'
    })
  }

  expect(
    violations.filter((violation) => violation.id !== 'color-contrast')
  ).toEqual([])
}

test.beforeEach(async ({ fixtureRuntime }) => {
  test.skip(
    fixtureRuntime.server === undefined,
    'Accessibility baselines require the stable local fixture data.'
  )
})

test('runs list has no detectable structural WCAG A/AA violations', async ({
  page
}, testInfo) => {
  await openAuthenticatedRuns(page)
  await expectNoAccessibilityViolations(page, testInfo)
})

test('run detail has no detectable structural WCAG A/AA violations', async ({
  page
}, testInfo) => {
  await openAuthenticatedRuns(page)
  await page.locator('tbody tr:first-child td a').first().click()
  await page.locator('.run-progress-timeline').waitFor()
  await expectNoAccessibilityViolations(page, testInfo)
})

test('memory workspace has no detectable structural WCAG A/AA violations', async ({
  page
}, testInfo) => {
  await openAuthenticatedRuns(page)
  await page.goto('/memory', { waitUntil: 'networkidle' })
  await page.locator('main').waitFor()
  await expectNoAccessibilityViolations(page, testInfo)
})

test('trajectory viewer has no detectable structural WCAG A/AA violations', async ({
  page
}, testInfo) => {
  await openAuthenticatedRuns(page)
  await page.goto('/viewer', { waitUntil: 'networkidle' })
  await page.locator('main').waitFor()
  await expectNoAccessibilityViolations(page, testInfo)
})

test('stable error state has no detectable structural WCAG A/AA violations', async ({
  page
}, testInfo) => {
  await openAuthenticatedRuns(page)
  await page.goto('/runs/fixture-artifact-load-error/files', {
    waitUntil: 'networkidle'
  })
  await page
    .getByText('The run files could not be opened.', { exact: true })
    .waitFor()
  await expectNoAccessibilityViolations(page, testInfo)
})
