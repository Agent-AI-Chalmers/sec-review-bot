import type { Page } from '@playwright/test'

import { expect, test } from './fixtures.js'

type Theme = 'light' | 'dark'

async function openFixturePage(
  page: Page,
  path: string,
  theme: Theme
): Promise<void> {
  await page.addInitScript((selectedTheme) => {
    localStorage.setItem('ui-theme', selectedTheme)
  }, theme)
  await page.goto(path, { waitUntil: 'networkidle' })
  await page.locator('main').waitFor()
  await page.evaluate(async () => document.fonts.ready)
  // Times keep changing even when the layout is correct. Hide only that live data;
  // rows, columns, colors, spacing, and responsive behavior remain in the image.
  await page.addStyleTag({
    content: `
      [data-label='Last activity'] { visibility: hidden !important; }
      *, *::before, *::after {
        animation-duration: 0s !important;
        transition-duration: 0s !important;
        caret-color: transparent !important;
      }
    `
  })
}

async function expectPageSnapshot(page: Page, name: string): Promise<void> {
  await expect(page).toHaveScreenshot(name, {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixelRatio: 0.001,
    scale: 'css'
  })
}

test.beforeEach(async ({ fixtureRuntime }) => {
  test.skip(
    fixtureRuntime.server === undefined,
    'Visual baselines require the stable local fixture data.'
  )
})

test('runs list light theme', async ({ page }) => {
  await openFixturePage(page, '/runs', 'light')
  await page.getByRole('heading', { name: 'Runs' }).waitFor()
  await expectPageSnapshot(page, 'runs-list-light.png')
})

test('runs list dark theme', async ({ page }) => {
  await openFixturePage(page, '/runs', 'dark')
  await page.getByRole('heading', { name: 'Runs' }).waitFor()
  await expectPageSnapshot(page, 'runs-list-dark.png')
})

test('memory workspace', async ({ page }) => {
  await openFixturePage(page, '/memory', 'light')
  await page.getByRole('heading', { name: 'Memory' }).waitFor()
  await expectPageSnapshot(page, 'memory-light.png')
})

test('trajectory viewer', async ({ page }) => {
  await openFixturePage(page, '/viewer', 'light')
  await expectPageSnapshot(page, 'viewer-light.png')
})

test('run files error state', async ({ page }) => {
  await openFixturePage(page, '/runs/fixture-artifact-load-error/files', 'dark')
  await page
    .getByText('The run files could not be opened.', { exact: true })
    .waitFor()
  await expectPageSnapshot(page, 'run-files-error-dark.png')
})
