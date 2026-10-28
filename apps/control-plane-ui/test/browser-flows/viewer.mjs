import { Buffer } from 'node:buffer'
import assert from 'node:assert/strict'

export async function runViewerFlow({ page }) {
  await page.getByRole('link', { name: 'Viewer', exact: true }).click()
  await page.getByRole('heading', { name: 'Transcript Viewer' }).waitFor()
  const pastedTranscript = [
    JSON.stringify({
      seq: 1,
      event: 'message',
      message: { type: 'system', content: 'Pasted system prompt' }
    }),
    JSON.stringify({
      seq: 2,
      event: 'message',
      message: {
        type: 'ai',
        content: [
          { type: 'text', text: 'Pasted assistant response' },
          { type: 'thinking', thinking: 'Pasted reasoning detail' }
        ],
        tool_calls: [
          {
            id: 'replace-1',
            name: 'replace_text',
            args: { old_string: 'unsafe', new_string: 'validated' }
          }
        ],
        usage_metadata: {
          input_tokens: 1200,
          output_tokens: 225,
          total_tokens: 1425,
          input_token_details: { cache_read: 450, cache_creation: 24 },
          output_token_details: { reasoning: 34 }
        }
      }
    }),
    JSON.stringify({
      seq: 3,
      event: 'message',
      message: {
        type: 'tool',
        name: 'replace_text',
        tool_call_id: 'replace-1',
        content: Array.from(
          { length: 80 },
          (_, index) => `replacement complete ${index + 1}`
        ).join('\n'),
        artifact: { source: 'workspace', changed_files: 1 }
      }
    })
  ].join('\n')
  await page
    .getByLabel('Paste transcript JSONL or JSON messages')
    .fill(pastedTranscript)
  await page.getByRole('button', { name: 'Render' }).click()
  await page.getByRole('button', { name: 'Edit input' }).waitFor()
  await page
    .getByLabel('Paste transcript JSONL or JSON messages')
    .waitFor({ state: 'hidden' })
  await page
    .locator('.transcript-timeline')
    .getByText('Pasted assistant response', { exact: true })
    .waitFor()
  await page.getByRole('button', { name: 'Expand all' }).click()
  await page.getByText('Pasted reasoning detail', { exact: true }).waitFor()
  await page.getByText('Before', { exact: true }).first().waitFor()
  await page.getByText('After', { exact: true }).first().waitFor()
  await page.getByRole('button', { name: 'Jump to result' }).waitFor()
  // "Expand all" animates every section, and scrollIntoView picks its target from
  // the current layout. Navigating while a section is still growing lands on a
  // stale offset, so wait for the transcript height to settle first.
  let previousHeight = -1
  let stableSamples = 0
  let settled = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const height = await page.evaluate(() =>
      Math.round(
        document.querySelector('.transcript-timeline')?.getBoundingClientRect()
          .height ?? 0
      )
    )
    if (height > 0 && height === previousHeight) {
      stableSamples += 1
      if (stableSamples >= 2) {
        settled = true
        break
      }
    } else {
      stableSamples = 0
    }
    previousHeight = height
    await page.waitForTimeout(100)
  }
  if (!settled)
    throw new Error('transcript layout did not settle before minimap checks')

  if ((page.viewportSize()?.width ?? 0) > 700) {
    const minimap = page.getByRole('navigation', {
      name: 'Transcript navigation'
    })
    await minimap.waitFor()
    const segments = minimap.locator('.transcript-minimap-segment')
    assert.strictEqual(
      await segments.count(),
      3,
      'the minimap must create one primary segment per visible top-level message'
    )
    const current = minimap.locator(
      '.transcript-minimap-segment[data-current="true"]'
    )
    assert.strictEqual(
      await current.count(),
      1,
      'the minimap must identify exactly one message nearest the viewport center'
    )
    const slider = minimap.getByRole('slider', {
      name: 'Transcript position'
    })
    await slider.waitFor()
    const controls = await slider.getAttribute('aria-controls')
    assert.ok(
      controls,
      'the minimap slider must control the transcript timeline'
    )
    assert.strictEqual(
      await page.evaluate(
        (id) =>
          document
            .getElementById(id)
            ?.classList.contains('transcript-timeline') === true,
        controls
      ),
      true,
      'the minimap slider must point at the transcript timeline'
    )
    assert.strictEqual(
      await slider.getAttribute('aria-valuemax'),
      '3',
      'the minimap slider must span every visible message'
    )
    const sliderBox = await slider.boundingBox()
    const middleBox = await segments.nth(1).boundingBox()
    assert.ok(
      sliderBox !== null && middleBox !== null,
      'the minimap slider and its middle tick must have a layout box'
    )
    const middleY = middleBox.y - sliderBox.y + middleBox.height / 2

    await slider.hover({ position: { x: sliderBox.width / 2, y: middleY } })
    const preview = minimap.locator('.transcript-minimap-preview')
    await preview.waitFor()
    assert.match(
      (await preview.textContent()) ?? '',
      /#2/,
      'hovering the track must preview the message under the pointer'
    )
    await slider.focus()
    await page.keyboard.press('Home')
    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="slider"]')
          ?.getAttribute('aria-valuenow') === '1',
      null,
      { timeout: 5_000 }
    )
    // Both presses must advance. Wait for the first jump to land instead of
    // sleeping: a fixed delay can race the scroll listener on a busy runner.
    await page.keyboard.press('ArrowDown')
    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="slider"]')
          ?.getAttribute('aria-valuenow') === '2',
      null,
      { timeout: 5_000 }
    )
    await page.keyboard.press('ArrowDown')
    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="slider"]')
          ?.getAttribute('aria-valuenow') === '3',
      null,
      { timeout: 5_000 }
    )

    const clickSliderBox = await slider.boundingBox()
    const clickMiddleBox = await segments.nth(1).boundingBox()
    assert.ok(
      clickSliderBox !== null && clickMiddleBox !== null,
      'the minimap slider and its middle tick must have a layout box'
    )
    await slider.click({
      position: {
        x: clickSliderBox.width / 2,
        y: clickMiddleBox.y - clickSliderBox.y + clickMiddleBox.height / 2
      }
    })
    await page.waitForFunction(
      () =>
        document
          .querySelectorAll('.transcript-minimap-segment')[1]
          ?.getAttribute('data-current') === 'true',
      null,
      { timeout: 5_000 }
    )
    await page.waitForFunction(
      () => {
        const messages = document.querySelectorAll(
          '.transcript-timeline .transcript-message'
        )
        const element = messages[1]
        if (element === undefined) return false
        const rect = element.getBoundingClientRect()
        return rect.bottom > 0 && rect.top < globalThis.innerHeight
      },
      null,
      { timeout: 5_000 }
    )

    const denseTranscript = Array.from({ length: 130 }, (_, index) =>
      JSON.stringify({
        seq: index + 1,
        event: 'message',
        message: { type: 'human', content: `Dense message ${index + 1}` }
      })
    ).join('\n')
    await page.getByRole('button', { name: 'Edit input' }).click()
    await page
      .getByLabel('Paste transcript JSONL or JSON messages')
      .fill(denseTranscript)
    await page.getByRole('button', { name: 'Render' }).click()
    await page.getByText('Dense message 130', { exact: true }).waitFor()
    await page.waitForFunction(
      () => document.querySelectorAll('.transcript-minimap-segment').length > 1,
      null,
      { timeout: 5_000 }
    )
    const denseMarkCount = await page
      .locator('.transcript-minimap-segment')
      .count()
    assert.ok(
      denseMarkCount <= 26,
      `dense minimap must cap its marks: ${denseMarkCount}`
    )
    assert.strictEqual(
      await page
        .locator('.transcript-minimap-segment[data-current="true"]')
        .count(),
      1,
      'exactly one current mark must be drawn after bucketing'
    )
    assert.strictEqual(
      await page
        .getByRole('slider', { name: 'Transcript position' })
        .getAttribute('aria-valuemax'),
      '130',
      'the slider must keep addressing every dense message'
    )
  }

  const uploadedTranscript = JSON.stringify({
    messages: [{ type: 'human', content: 'Uploaded transcript message' }]
  })
  await page.locator('input[type="file"]').setInputFiles({
    name: 'sample-transcript.json',
    mimeType: 'application/json',
    buffer: Buffer.from(uploadedTranscript)
  })
  await page
    .locator('.transcript-timeline')
    .getByText('Uploaded transcript message', { exact: true })
    .waitFor()
}
