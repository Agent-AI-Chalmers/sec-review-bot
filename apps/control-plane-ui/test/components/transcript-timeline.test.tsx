import React from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'

import {
  TranscriptTimeline,
  type TranscriptEvent
} from '../../browser/features/transcript/TranscriptViewer.js'
import { renderComponent } from './render.js'

const events: TranscriptEvent[] = [
  {
    seq: 1,
    event: 'message',
    message: {
      type: 'ai',
      id: 'assistant-1',
      content: 'I will update the file.',
      tool_calls: [
        {
          id: 'replace-1',
          name: 'replace_text',
          args: { old_string: 'unsafe', new_string: 'validated' }
        }
      ]
    }
  },
  {
    seq: 2,
    event: 'message',
    message: {
      type: 'tool',
      id: 'result-1',
      name: 'replace_text',
      tool_call_id: 'replace-1',
      content: 'replacement complete',
      artifact: { changed_files: 1 }
    }
  }
]

test('tool results show result data without repeating call arguments', async () => {
  const user = userEvent.setup()
  renderComponent(<TranscriptTimeline events={events} />)

  await user.click(screen.getByRole('button', { name: 'Expand all' }))

  const toolResult = document.querySelector<HTMLElement>(
    '[data-transcript-role="tool"]'
  )
  expect(toolResult).not.toBeNull()
  const result = within(toolResult!)

  expect(result.getByRole('button', { name: 'Back to call' })).toBeVisible()
  expect(result.getByText('replacement complete')).toBeVisible()
  const artifact = toolResult!.querySelector(
    '[data-transcript-section="artifact"]'
  )
  expect(artifact).toHaveTextContent(/changed_files.*1/)
  expect(result.queryByText('old_string')).not.toBeInTheDocument()
  expect(result.queryByText('unsafe')).not.toBeInTheDocument()
})

test('usage details expose totals and token subsets', async () => {
  const user = userEvent.setup()
  const usageEvents: TranscriptEvent[] = [
    {
      seq: 1,
      event: 'message',
      message: {
        type: 'ai',
        content: 'Usage-bearing response.',
        usage_metadata: {
          input_tokens: 1_200,
          output_tokens: 225,
          total_tokens: 1_425,
          input_token_details: { cache_read: 450, cache_creation: 24 },
          output_token_details: { reasoning: 34 }
        }
      }
    }
  ]
  renderComponent(<TranscriptTimeline events={usageEvents} />)

  await user.click(screen.getAllByRole('button', { name: 'Usage details' })[0]!)

  const details = await waitFor(() => {
    const element = document.querySelector<HTMLElement>(
      '.transcript-usage-details'
    )
    expect(element).not.toBeNull()
    return element!
  })
  expect(details).toHaveTextContent(/Input\s*1,200/)
  expect(details).toHaveTextContent(/Cache read\s*450/)
  expect(details).toHaveTextContent(/Cache write\s*24/)
  expect(details).toHaveTextContent(/Output\s*225/)
  expect(details).toHaveTextContent(/Reasoning\s*34/)
  expect(details).toHaveTextContent(/Total\s*1,425/)
})

test('optional transcript controls are absent without their source data', () => {
  const sparseEvents: TranscriptEvent[] = [
    {
      seq: 1,
      event: 'message',
      message: { type: 'tool', content: 'Unlinked result' }
    }
  ]
  renderComponent(<TranscriptTimeline events={sparseEvents} />)

  const result = document.querySelector<HTMLElement>(
    '[data-transcript-role="tool"]'
  )
  expect(result).not.toBeNull()
  expect(
    result!.querySelector('[data-transcript-action="back-to-call"]')
  ).not.toBeInTheDocument()
  expect(
    result!.querySelector('[data-transcript-section="artifact"]')
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Usage details' })
  ).not.toBeInTheDocument()
})
