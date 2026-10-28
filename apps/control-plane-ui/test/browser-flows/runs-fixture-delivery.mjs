import assert from 'node:assert/strict'

import { openPublishedRepositoryRun } from './runs-fixture-support.mjs'

export async function runFixtureRunDeliveryFlow({
  name,
  viewport,
  page,
  base,
  waitUntil
}) {
  await openPublishedRepositoryRun({ name, page, base, waitUntil })

  const publicationBody =
    (await page
      .locator('.run-progress-timeline .mantine-Timeline-itemBody')
      .nth(3)
      .textContent()) ?? ''
  if (!/took/.test(publicationBody)) {
    // The publication phase only renders elapsed time when it has a start. Include the
    // served run in the failure because a bad fixture and a stale list row look identical.
    const runId = decodeURIComponent(new URL(page.url()).pathname)
      .split('/')
      .pop()
    const served = await page.evaluate(async (id) => {
      const response = await fetch(`/api/runs/${encodeURIComponent(id)}`)
      if (!response.ok) return { status: response.status }
      const { run } = await response.json()
      return {
        status: response.status,
        workflow: run.workflow,
        publication: run.publication,
        execution: run.execution,
        preparation_status: run.preparation?.status
      }
    }, runId)
    assert.fail(
      `${name} a finished phase must read as a duration: opened ${runId}, timeline ` +
        `body ${JSON.stringify(publicationBody)}, server ${JSON.stringify(served)}`
    )
  }

  // Compare centres rather than tops because the artifact facts use different font sizes.
  const artifact = await page.evaluate(() => {
    const row = document.querySelector('.artifact-row')
    if (row === null) return { found: false }
    const action = row.querySelector('.artifact-actions')
    const facts = [...row.querySelectorAll('.artifact-facts > *')].map(
      (element) => element.getBoundingClientRect()
    )
    const centres = facts.map((box) => Math.round(box.y + box.height / 2))
    return {
      found: true,
      facts: facts.length,
      sameLine: new Set(centres).size === 1,
      actionTrails:
        action !== null &&
        Math.abs(
          action.getBoundingClientRect().right -
            row.getBoundingClientRect().right
        ) < 2
    }
  })
  assert.ok(artifact.found, `${name} a stored artifact must render`)
  assert.strictEqual(
    artifact.facts,
    3,
    `${name} the artifact must show size, type and digest`
  )
  if (viewport.width >= 768) {
    assert.ok(
      artifact.sameLine,
      `${name} the artifact facts must share one line`
    )
  }
  assert.ok(
    artifact.actionTrails,
    `${name} the file viewer must trail the artifact row`
  )
  assert.strictEqual(
    await page.locator('.artifact-row > .mantine-Badge-root').count(),
    1,
    `${name} the artifact row must lead with its status badge`
  )

  // These blocks have crowded the line above them before, so preserve visible spacing.
  const breathing = await page.evaluate(() => {
    const stamp = [
      ...document.querySelectorAll('.mantine-Timeline-itemBody p')
    ].find((paragraph) => paragraph.textContent.includes('\u00b7 took'))
    const row = document.querySelector('.artifact-row')
    const summary = document.querySelector('.publication-summary p')
    const firstStep = document.querySelector('.delivery-item')
    const gap = (above, below) =>
      above === null || below === null
        ? null
        : Math.round(
            below.getBoundingClientRect().top -
              above.getBoundingClientRect().bottom
          )
    return {
      artifact: gap(stamp ?? null, row),
      publication: gap(summary ?? null, firstStep)
    }
  })
  for (const [label, value] of Object.entries(breathing)) {
    assert.ok(
      value === null || value >= 8,
      `${name} the ${label} block must not touch the line above it (saw ${value})`
    )
  }

  const digest = page.locator('.artifact-digest-toggle')
  assert.strictEqual(
    await digest.getAttribute('aria-expanded'),
    'false',
    `${name} digest starts short`
  )
  const collapsed = (await digest.textContent()) ?? ''
  await digest.click()
  await waitUntil(
    async () => (await digest.getAttribute('aria-expanded')) === 'true',
    `${name} digest did not expand`
  )
  assert.strictEqual(
    await digest.getAttribute('aria-expanded'),
    'true',
    `${name} digest must expand`
  )
  assert.ok(
    ((await digest.textContent()) ?? '').length > collapsed.length,
    `${name} expanding the digest must reveal more of it`
  )

  await page.getByRole('button', { name: 'View files' }).click()
  const runFilesDialog = page.getByRole('dialog', { name: 'Run files' })
  await runFilesDialog.waitFor()
  await runFilesDialog.locator('.file-workspace-preview > ul').waitFor()
  await runFilesDialog.getByText('review.jsonl', { exact: true }).click()
  await waitUntil(
    async () => (await runFilesDialog.locator('.jsonl-record').count()) === 2,
    `${name} JSONL preview did not render both records`
  )
  assert.strictEqual(
    await runFilesDialog.locator('.jsonl-record').count(),
    2,
    `${name} JSONL preview must render one collapsible record per line`
  )
  await runFilesDialog
    .getByRole('radio', { name: 'Source' })
    .evaluate((element) => element.click())
  await runFilesDialog.locator('.cm-editor').waitFor()
  assert.strictEqual(
    await runFilesDialog
      .locator('.cm-content[contenteditable="false"]')
      .count(),
    1,
    `${name} run file source must use a read-only CodeMirror view`
  )
  await page.keyboard.press('Escape')
  await runFilesDialog.waitFor({ state: 'hidden' })

  // Wide rows keep status, identity, and exit on one line. Narrow rows stack the
  // identity below the status but still preserve the same reading order.
  const stacked = await page.$eval(
    '.delivery-main',
    (element) => getComputedStyle(element).flexDirection === 'column'
  )
  const stepLayout = await page.$$eval('.delivery-item', (items) =>
    items.map((item) => {
      const badge = item
        .querySelector('.mantine-Badge-root')
        ?.getBoundingClientRect()
      const key = item
        .querySelector('.delivery-step-key')
        ?.getBoundingClientRect()
      const link = item.querySelector('.delivery-link')?.getBoundingClientRect()
      return {
        badgeY: badge?.y ?? null,
        keyY: key?.y ?? null,
        keyRight: key?.right ?? null,
        linkLeft: link?.left ?? null
      }
    })
  )
  assert.ok(
    stepLayout.length > 0,
    `${name} the published run must list its steps`
  )
  for (const step of stepLayout) {
    if (step.badgeY !== null && step.keyY !== null) {
      if (stacked) {
        assert.ok(
          step.keyY > step.badgeY,
          `${name} a stacked step must read status then key`
        )
      } else {
        assert.ok(
          Math.abs(step.badgeY - step.keyY) < 6,
          `${name} a step key must sit beside its status`
        )
      }
    }
    if (!stacked && step.linkLeft !== null && step.keyRight !== null) {
      assert.ok(
        step.linkLeft > step.keyRight,
        `${name} a step link must trail its row`
      )
    }
  }

  const deliverySteps = await page.locator('.delivery-item').count()
  assert.ok(
    deliverySteps > 1,
    `${name} a published repository review must show its steps (saw ${deliverySteps})`
  )

  // A single-result workflow uses the same row shape. Set both filters in the URL because
  // changing the two URL-backed selects back to back can discard one navigation.
  await page.goto(
    `${base}/runs?workflow=issue-review&publication_status=published`,
    { waitUntil: 'networkidle' }
  )
  await page.getByRole('heading', { name: 'Runs' }).waitFor()
  await page.locator('tbody tr:first-child td a').first().waitFor()
  await page.locator('tbody tr:first-child td a').first().click()
  await page.waitForSelector('.delivery-item')
  assert.strictEqual(
    await page.locator('.publication-summary .delivery-link').count(),
    0,
    `${name} the summary must not carry the exit link`
  )
  const single = await page.evaluate(() => {
    const item = document.querySelector('.delivery-item')
    if (item === null) return { found: false }
    const key = item
      .querySelector('.delivery-step-key')
      ?.getBoundingClientRect()
    const link = item.querySelector('.delivery-link')?.getBoundingClientRect()
    return {
      found: true,
      badge: item.querySelector('.mantine-Badge-root') !== null,
      key: item.querySelector('.delivery-step-key') !== null,
      trailing: link !== undefined && key !== undefined && link.left > key.right
    }
  })
  assert.ok(
    single.found && single.badge && single.key,
    `${name} a single result needs its row`
  )
  assert.ok(
    single.found && single.trailing,
    `${name} a single exit must trail its row`
  )
}
