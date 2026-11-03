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
