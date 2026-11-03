import { readFileSync } from 'node:fs'
import { transcriptCorpus } from '../contract-fixtures.ts'
import { expect } from '@playwright/test'

import { runViewerFlow } from '../browser-flows/viewer.mjs'
import { openAuthenticatedRuns, test } from './fixtures.ts'

test('viewer browser behavior', async ({ page }) => {
  await openAuthenticatedRuns(page)
  await runViewerFlow({ page })
})

test('runtime recordings show natural flat order with subagent and summary labels', async ({
  page
}) => {
  await openAuthenticatedRuns(page)
  await page.getByRole('link', { name: 'Viewer', exact: true }).click()
  for (const name of ['subagents', 'summarization']) {
    const edit = page.getByRole('button', { name: 'Edit input' })
    if (await edit.isVisible()) await edit.click()
    const raw = transcriptCorpus(`${name}.jsonl`)
    await page.getByLabel('Paste transcript JSONL').fill(raw)
    await page.getByRole('button', { name: 'Render', exact: true }).click()
    const messages = page.locator('[data-trajectory-message-key]')
    await expect(messages.first()).toHaveAttribute(
      'data-trajectory-role',
      'system'
    )
    await expect(messages.nth(1)).toHaveAttribute(
      'data-trajectory-role',
      'human'
    )
    if (name === 'subagents') {
      for (const agent of ['source-reviewer', 'test-reviewer']) {
        const branch = page.locator(
          `[data-trajectory-message-key][data-trajectory-agent="${agent}"]`
        )
        await expect(branch.first()).toHaveAttribute(
          'data-trajectory-role',
          'system'
        )
        await expect(branch.nth(1)).toHaveAttribute(
          'data-trajectory-role',
          'human'
        )
      }
    } else {
      const summary = page.locator(
        '[data-trajectory-message-key][data-trajectory-source="summarization"]'
      )
      await expect(summary.first()).toHaveAttribute(
        'data-trajectory-role',
        'human'
      )
      await expect(summary.nth(1)).toHaveAttribute(
        'data-trajectory-role',
        'assistant'
      )
      await expect(summary.nth(2)).toHaveAttribute(
        'data-trajectory-role',
        'human'
      )
      await summary
        .first()
        .getByRole('button', { name: /Message/ })
        .click()
      await expect(summary.first()).toContainText(
        'Context Extraction Assistant'
      )
      await expect(summary.first()).not.toContainText('<primary_objective>')
      await summary.first().getByText('Source', { exact: true }).click()
      await expect(summary.first().locator('pre')).toContainText('<role>')
      await expect(summary.first().locator('pre')).toContainText(
        '<primary_objective>'
      )
      await summary.first().getByText('Preview', { exact: true }).click()
      await expect(summary.first()).not.toContainText('<primary_objective>')
      await summary
        .first()
        .locator('.trajectory-section-header')
        .first()
        .scrollIntoViewIfNeeded()
      await page.screenshot({
        path: test.info().outputPath('summary-preview.png')
      })
      await summary.first().getByText('Source', { exact: true }).click()
      await page.screenshot({
        path: test.info().outputPath('summary-source.png')
      })
    }
  }
})

test('failed analysis retains readable tool errors and repeated prompt navigation', async ({
  page
}) => {
  await openAuthenticatedRuns(page)
  await page.getByRole('link', { name: 'Viewer', exact: true }).click()
  const raw = readFileSync(
    new URL('../fixtures/trajectory-failed-analysis.jsonl', import.meta.url),
    'utf8'
  )
  await page.getByLabel('Paste transcript JSONL').fill(raw)
  await page.getByRole('button', { name: 'Render', exact: true }).click()
  const references = page.getByRole('button', {
    name: 'Unchanged system instructions — view earlier message'
  })
  await expect(references).toHaveCount(4)
  await references.last().click()
  await expect(
    page.locator('[data-trajectory-role="system"]').first()
  ).toBeInViewport()
  await page.getByRole('button', { name: 'Expand all' }).click()
  await expect(
    page.getByText('Recorded arguments: {}', { exact: true })
  ).toHaveCount(5)
  await expect(
    page.getByText('/workspace/project/src', { exact: true })
  ).toBeVisible()
  await expect(
    page
      .locator('.trajectory-message-body')
      .filter({ hasText: '"type": "function_call"' })
  ).toHaveCount(0)
  const errors = page.locator(
    '.trajectory-tool-call[data-result-status="error"]'
  )
  await expect(errors).toHaveCount(5)
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.setAttribute('data-mantine-color-scheme', value)
    }, theme)
    const callBadgeStyle = await errors
      .first()
      .locator('.mantine-Badge-root')
      .evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        foreground: getComputedStyle(element).color,
        variant: element.getAttribute('data-variant')
      }))
    expect(callBadgeStyle.variant).toBe('light')
    const resultErrors = page
      .locator('[data-trajectory-role="tool"] .mantine-Badge-root')
      .filter({ hasText: /^error$/i })
    await expect(resultErrors).toHaveCount(5)
    for (const badge of await resultErrors.all()) {
      const style = await badge.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        foreground: getComputedStyle(element).color,
        variant: element.getAttribute('data-variant')
      }))
      expect(style).toEqual(callBadgeStyle)
      const background = style.background
      const [red, green, blue] = background.match(/[\d.]+/g).map(Number)
      expect(red).toBeGreaterThan(green)
      expect(red).toBeGreaterThan(blue)
    }
    const card = errors.first()
    await card.scrollIntoViewIfNeeded()
    const appearance = await card.evaluate((element, viewportWidth) => {
      const identity = element.querySelector('.trajectory-tool-call-identity')
      const name = identity.querySelector('.mantine-Text-root')
      const badge = identity.querySelector('.mantine-Badge-root')
      const icon = identity.querySelector('svg')
      const isRed = (color) => {
        const channels = color.match(/[\d.]+/g).map(Number)
        return channels[0] > channels[1] && channels[0] > channels[2]
      }
      const badgeBox = badge.getBoundingClientRect()
      const nameBox = name.getBoundingClientRect()
      return {
        redBorder: isRed(getComputedStyle(element).borderLeftColor),
        redName: isRed(getComputedStyle(name).color),
        redIcon: isRed(getComputedStyle(icon).stroke),
        badgeBesideName:
          badgeBox.left >= nameBox.right &&
          Math.abs(badgeBox.top - nameBox.top) < 10,
        fitsViewport: element.getBoundingClientRect().right <= viewportWidth
      }
    }, page.viewportSize().width)
    expect(appearance).toEqual({
      redBorder: true,
      redName: true,
      redIcon: true,
      badgeBesideName: true,
      fitsViewport: true
    })
    await card.screenshot({
      path: test.info().outputPath(`failed-tool-${theme}.png`)
    })
  }
})

test('truncated transcript shows a parse alert outside message cards', async ({
  page
}) => {
  await openAuthenticatedRuns(page)
  await page.getByRole('link', { name: 'Viewer', exact: true }).click()
  const raw = readFileSync(
    new URL(
      '../../../../contracts/agent-transcript/v1/corpus/truncated.jsonl',
      import.meta.url
    ),
    'utf8'
  )
  await page.getByLabel('Paste transcript JSONL').fill(raw)
  await page.getByRole('button', { name: 'Render', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.locator('.trajectory-message')).toHaveCount(0)
  await page
    .getByRole('alert')
    .screenshot({ path: test.info().outputPath('transcript-parse-error.png') })
})
