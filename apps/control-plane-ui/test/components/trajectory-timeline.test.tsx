import React from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'

import { TrajectoryTimeline } from '../../browser/features/trajectory/TrajectoryTimeline.js'
import type { TrajectoryEvent } from '../../browser/features/trajectory/trajectory-model.js'
import { renderComponent } from './render.js'

const events: TrajectoryEvent[] = [
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

test('assistant messages show model provenance before the agent name', () => {
  const modelEvents: TrajectoryEvent[] = [
    {
      seq: 1,
      event: 'message',
      message: {
        type: 'ai',
        id: 'assistant-model',
        name: 'issue-analyzer',
        content: 'hello',
        response_metadata: {
          model_provider: 'deepseek',
          model_name: 'deepseek-v4-pro'
        }
      }
    }
  ]
  renderComponent(<TrajectoryTimeline events={modelEvents} />)

  expect(screen.getByText('deepseek · deepseek-v4-pro')).toBeVisible()
  // Agent names are not rendered on assistant turns: the name field is an
  // overloaded label, so the header shows provenance instead.
  expect(screen.queryByText(/issue-analyzer/)).not.toBeInTheDocument()
})

test('apply_patch arguments render as a line-oriented patch', async () => {
  const user = userEvent.setup()
  const patchEvents: TrajectoryEvent[] = [
    {
      seq: 1,
      event: 'message',
      message: {
        type: 'ai',
        id: 'assistant-patch',
        content: '',
        tool_calls: [
          {
            id: 'patch-1',
            name: 'apply_patch',
            args: {
              patchText: [
                '*** Begin Patch',
                '*** Update File: src/main.js',
                '@@',
                '-const unsafe = true',
                '+const safe = true',
                '*** End Patch'
              ].join('\n')
            }
          }
        ]
      }
    }
  ]
  renderComponent(<TrajectoryTimeline events={patchEvents} />)

  await user.click(screen.getByRole('button', { name: 'Expand all' }))

  expect(document.querySelector('[data-trajectory-patch]')).not.toBeNull()
  expect(document.querySelector('[data-patch-line="add"]')).toHaveTextContent(
    '+const safe = true'
  )
  expect(
    document.querySelector('[data-patch-line="remove"]')
  ).toHaveTextContent('-const unsafe = true')
  const fileLines = [
    ...document.querySelectorAll('[data-patch-line="file"]')
  ].map((element) => element.textContent)
  expect(fileLines).toContain('*** Update File: src/main.js')
  // The raw argument key must not also appear as a JSON field.
  expect(screen.queryByText('patchText')).not.toBeInTheDocument()
})

test('tool results show result data without repeating call arguments', async () => {
  const user = userEvent.setup()
  renderComponent(<TrajectoryTimeline events={events} />)

  await user.click(screen.getByRole('button', { name: 'Expand all' }))

  const toolResult = document.querySelector<HTMLElement>(
    '[data-trajectory-role="tool"]'
  )
  expect(toolResult).not.toBeNull()
  const result = within(toolResult!)

  expect(result.getByRole('button', { name: 'Back to call' })).toBeVisible()
  expect(result.getByText('replacement complete')).toBeVisible()
  const artifact = toolResult!.querySelector(
    '[data-trajectory-section="artifact"]'
  )
  expect(artifact).toHaveTextContent(/changed_files.*1/)
  expect(result.queryByText('old_string')).not.toBeInTheDocument()
  expect(result.queryByText('unsafe')).not.toBeInTheDocument()
})

test('usage details expose totals and token subsets', async () => {
  const user = userEvent.setup()
  const usageEvents: TrajectoryEvent[] = [
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
  renderComponent(<TrajectoryTimeline events={usageEvents} />)

  await user.click(screen.getAllByRole('button', { name: 'Usage details' })[0]!)

  const details = await waitFor(() => {
    const element = document.querySelector<HTMLElement>(
      '.trajectory-usage-details'
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

test('optional trajectory controls are absent without their source data', () => {
  const sparseEvents: TrajectoryEvent[] = [
    {
      seq: 1,
      event: 'message',
      message: { type: 'tool', content: 'Unlinked result' }
    }
  ]
  renderComponent(<TrajectoryTimeline events={sparseEvents} />)

  const result = document.querySelector<HTMLElement>(
    '[data-trajectory-role="tool"]'
  )
  expect(result).not.toBeNull()
  expect(
    result!.querySelector('[data-trajectory-action="back-to-call"]')
  ).not.toBeInTheDocument()
  expect(
    result!.querySelector('[data-trajectory-section="artifact"]')
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Usage details' })
  ).not.toBeInTheDocument()
})
