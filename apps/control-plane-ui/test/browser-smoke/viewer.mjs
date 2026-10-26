import { Buffer } from 'node:buffer'

export async function smokeViewer({ page }) {
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
        ]
      }
    }),
    JSON.stringify({
      seq: 3,
      event: 'message',
      message: {
        type: 'tool',
        name: 'replace_text',
        tool_call_id: 'replace-1',
        content: 'replacement complete'
      }
    })
  ].join('\n')
  await page
    .getByLabel('Paste transcript JSONL or JSON messages')
    .fill(pastedTranscript)
  await page.getByRole('button', { name: 'Render' }).click()
  await page
    .locator('.transcript-timeline')
    .getByText('Pasted assistant response', { exact: true })
    .waitFor()
  await page.getByRole('button', { name: 'Expand all' }).click()
  await page.getByText('Pasted reasoning detail', { exact: true }).waitFor()
  await page.getByText('Before', { exact: true }).first().waitFor()
  await page.getByText('After', { exact: true }).first().waitFor()
  await page.getByRole('button', { name: 'Jump to result' }).waitFor()
  await page.getByRole('button', { name: 'Back to call' }).waitFor()
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
