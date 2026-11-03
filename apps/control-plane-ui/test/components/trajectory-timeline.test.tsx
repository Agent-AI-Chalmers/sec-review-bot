import React from 'react'
import { readFileSync } from 'node:fs'
import { readTrajectoryJsonl } from '../../shared/trajectory-events.js'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { TrajectoryTimeline } from '../../browser/features/trajectory/TrajectoryTimeline.js'
import type { TrajectoryEvent } from '../../browser/features/trajectory/trajectory-model.js'
import { renderComponent } from './render.js'

const events: TrajectoryEvent[] = [
  {
    seq: 1,
    event: 'message',
    message: {
      role: 'assistant',
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
      role: 'tool',
      id: 'result-1',
      name: 'replace_text',
      tool_call_id: 'replace-1',
      content: 'replacement complete',
      artifact: { changed_files: 1 }
    }
  }
]

test('argument rendering is decided by key, not by content heuristics', () => {
  const policyEvents: TrajectoryEvent[] = [
    {
      seq: 1,
      event: 'message',
      message: {
        role: 'assistant',
        id: 'assistant-policy',
        content: '',
        tool_calls: [
          {
            id: 'report-1',
            name: 'report',
            args: {
              description: '**Important** notes',
              payload: 'line one\nline two with **stars**'
            }
          }
        ]
      }
    }
  ]
  renderComponent(<TrajectoryTimeline events={policyEvents} />)

  // A known prose key is markdown.
  const markdown = document.querySelector('.json-markdown')
  expect(markdown?.querySelector('strong')).toHaveTextContent('Important')
  // An unknown key is data: whitespace preserved, markdown not interpreted.
  const block = document.querySelector('.json-code-block')
  expect(block).toHaveTextContent('line two with **stars**')
  expect(block?.querySelector('strong')).toBeNull()
})

test('hunk content starting with --- or +++ is data, not a file header', () => {
  const trickyDiff: TrajectoryEvent[] = [
    {
      seq: 1,
      event: 'message',
      message: {
        role: 'assistant',
        id: 'assistant-tricky',
        content: '',
        tool_calls: [
          {
            id: 'edit-tricky',
            name: 'edit',
            args: { filePath: '/workspace/src/sample.txt' }
          }
        ]
      }
    },
    {
      seq: 2,
      event: 'message',
      message: {
        role: 'tool',
        id: 'tool-tricky',
        name: 'edit',
        tool_call_id: 'edit-tricky',
        content: 'Edit applied successfully.',
        additional_kwargs: {
          diff: [
            'Index: /workspace/src/sample.txt',
            '--- a/src/sample.txt',
            '+++ b/src/sample.txt',
            '@@ -1,2 +1,2 @@',
            ' keep',
            '--- old',
            '+++ new'
          ].join('\n')
        }
      }
    }
  ]
  renderComponent(<TrajectoryTimeline events={trickyDiff} />)

  const stats = document.querySelector('.trajectory-diff-file-stats')
  expect(stats).toHaveTextContent('+1')
  expect(stats).toHaveTextContent('−1')
  expect(
    document.querySelector('[data-patch-line="remove"]')
  ).toHaveTextContent('--- old')
  expect(document.querySelector('[data-patch-line="add"]')).toHaveTextContent(
    '+++ new'
  )
})

test('a deleted file keeps its own path and does not join the previous file', () => {
  const deleteDiff: TrajectoryEvent[] = [
    {
      seq: 1,
      event: 'message',
      message: {
        role: 'assistant',
        id: 'assistant-delete',
        content: '',
        tool_calls: [
          {
            id: 'edit-delete',
            name: 'edit',
            args: { filePath: '/workspace/gone.txt' }
          }
        ]
      }
    },
    {
      seq: 2,
      event: 'message',
      message: {
        role: 'tool',
        id: 'tool-delete',
        name: 'edit',
        tool_call_id: 'edit-delete',
        content: 'Edit applied successfully.',
        additional_kwargs: {
          diff: [
            'Index: /workspace/keep.txt',
            '--- a/keep.txt',
            '+++ b/keep.txt',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            'Index: /workspace/gone.txt',
            '--- a/gone.txt',
            '+++ /dev/null',
            '@@ -1,2 +0,0 @@',
            '-line one',
            '-line two'
          ].join('\n')
        }
      }
    }
  ]
  renderComponent(<TrajectoryTimeline events={deleteDiff} />)

  const files = document.querySelectorAll('.trajectory-diff-file')
  expect(files).toHaveLength(2)
  expect(
    files[1]?.querySelector('.trajectory-diff-file-path')
  ).toHaveTextContent('gone.txt')
  expect(files[1]?.querySelectorAll('[data-patch-line="remove"]')).toHaveLength(
    2
  )
  expect(files[1]).toHaveTextContent('line two')
  expect(within(files[1] as HTMLElement).getByText('Deleted')).toBeVisible()
})

test('Begin Patch delete and move keep their operation metadata', () => {
  const opsDiff: TrajectoryEvent[] = [
    {
      seq: 1,
      event: 'message',
      message: {
        role: 'assistant',
        id: 'assistant-ops',
        content: '',
        tool_calls: [
          {
            id: 'edit-ops',
            name: 'apply_patch',
            args: { patchText: '*** Begin Patch' }
          }
        ]
      }
    },
    {
      seq: 2,
      event: 'message',
      message: {
        role: 'tool',
        id: 'tool-ops',
        name: 'apply_patch',
        tool_call_id: 'edit-ops',
        content: 'Success.',
        additional_kwargs: {
          diff: [
            '*** Begin Patch',
            '*** Update File: /workspace/old.py',
            '*** Move to: /workspace/new.py',
            '@@',
            '-x = 1',
            '+x = 2',
            '*** Delete File: /workspace/gone.py',
            '*** End Patch'
          ].join('\n')
        }
      }
    }
  ]
  renderComponent(<TrajectoryTimeline events={opsDiff} />)

  const files = document.querySelectorAll('.trajectory-diff-file')
  expect(files).toHaveLength(2)
  const moved = files[0] as HTMLElement
  expect(moved.querySelector('.trajectory-diff-file-path')).toHaveTextContent(
    'old.py → new.py'
  )
  expect(within(moved).getByText('Moved')).toBeVisible()
  expect(moved.querySelector('.trajectory-diff-file-stats')).toHaveTextContent(
    '+1 −1'
  )

  const deleted = files[1] as HTMLElement
  expect(deleted.querySelector('.trajectory-diff-file-path')).toHaveTextContent(
    'gone.py'
  )
  expect(within(deleted).getByText('Deleted')).toBeVisible()
  // An operation-only file has no line stats to show.
  expect(deleted.querySelector('.trajectory-diff-file-stats')).toBeNull()
})

test('a damaged patch falls back to raw text instead of a wrong diff', () => {
  const brokenDiff: TrajectoryEvent[] = [
    {
      seq: 1,
      event: 'message',
      message: {
        role: 'assistant',
        id: 'assistant-broken',
        content: '',
        tool_calls: [
          {
            id: 'edit-broken',
            name: 'edit',
            args: { filePath: '/workspace/src/a.txt' }
          }
        ]
      }
    },
    {
      seq: 2,
      event: 'message',
      message: {
        role: 'tool',
        id: 'tool-broken',
        name: 'edit',
        tool_call_id: 'edit-broken',
        content: 'Edit applied successfully.',
        additional_kwargs: {
          diff: [
            'Index: /workspace/src/a.txt',
            '--- a/src/a.txt',
            '+++ b/src/a.txt',
            '@@ -1,4 +1,4 @@',
            ' keep'
          ].join('\n')
        }
      }
    }
  ]
  renderComponent(<TrajectoryTimeline events={brokenDiff} />)

  // No structured diff view: the advertised counts never complete.
  expect(document.querySelector('[data-diff-mode]')).toBeNull()
  const raw = document.querySelector('[data-trajectory-patch]')
  expect(raw).not.toBeNull()
  expect(raw).toHaveTextContent('@@ -1,4 +1,4 @@')
  expect(raw).toHaveTextContent('--- a/src/a.txt')
  expect(screen.getByText(/Patch structure could not be parsed/)).toBeVisible()
})

test('a truncated diff is labelled as partial', () => {
  const truncated: TrajectoryEvent[] = [
    {
      seq: 1,
      event: 'message',
      message: {
        role: 'assistant',
        id: 'assistant-truncated',
        content: '',
        tool_calls: [
          {
            id: 'edit-truncated',
            name: 'edit',
            args: { filePath: '/workspace/src/a.txt' }
          }
        ]
      }
    },
    {
      seq: 2,
      event: 'message',
      message: {
        role: 'tool',
        id: 'tool-truncated',
        name: 'edit',
        tool_call_id: 'edit-truncated',
        content: 'Edit applied successfully.',
        additional_kwargs: {
          diff: [
            'Index: /workspace/src/a.txt',
            '--- /workspace/src/a.txt',
            '+++ /workspace/src/a.txt',
            '@@ -1 +1 @@',
            '-old',
            '+new'
          ].join('\n'),
          diff_truncated: true
        }
      }
    }
  ]
  renderComponent(<TrajectoryTimeline events={truncated} />)

  expect(screen.getByText(/tool truncated this diff/i)).toBeVisible()
  expect(document.querySelector('[data-diff-mode="unified"]')).not.toBeNull()
})

test('content left after a hunk ends also falls back to raw text', () => {
  const earlyEnd: TrajectoryEvent[] = [
    {
      seq: 1,
      event: 'message',
      message: {
        role: 'assistant',
        id: 'assistant-early',
        content: '',
        tool_calls: [
          {
            id: 'edit-early',
            name: 'edit',
            args: { filePath: '/workspace/src/a.txt' }
          }
        ]
      }
    },
    {
      seq: 2,
      event: 'message',
      message: {
        role: 'tool',
        id: 'tool-early',
        name: 'edit',
        tool_call_id: 'edit-early',
        content: 'Edit applied successfully.',
        additional_kwargs: {
          diff: [
            'Index: /workspace/src/a.txt',
            '--- a/src/a.txt',
            '+++ b/src/a.txt',
            '@@ -1 +1 @@',
            ' keep',
            '+leftover'
          ].join('\n')
        }
      }
    }
  ]
  renderComponent(<TrajectoryTimeline events={earlyEnd} />)

  expect(document.querySelector('[data-diff-mode]')).toBeNull()
  const raw = document.querySelector('[data-trajectory-patch]')
  expect(raw).toHaveTextContent('+leftover')
})

test('command arguments render as a terminal block, not markdown', () => {
  const commandEvents: TrajectoryEvent[] = [
    {
      seq: 1,
      event: 'message',
      message: {
        role: 'assistant',
        id: 'assistant-command',
        content: '',
        tool_calls: [
          {
            id: 'exec-1',
            name: 'execute',
            args: {
              command: 'cd /tmp && python -c "print(1)"\necho done'
            }
          }
        ]
      }
    }
  ]
  renderComponent(<TrajectoryTimeline events={commandEvents} />)

  const block = document.querySelector('[data-trajectory-command]')
  expect(block).not.toBeNull()
  expect(block).toHaveTextContent('cd /tmp')
  expect(block).toHaveTextContent('echo done')
  // The markdown heuristic used to collapse commands into a paragraph.
  expect(document.querySelector('.memory-markdown')).toBeNull()
})

test('camelCase edit arguments fall back to a before/after pair', () => {
  const editEvents: TrajectoryEvent[] = [
    {
      seq: 1,
      event: 'message',
      message: {
        role: 'assistant',
        id: 'assistant-edit',
        content: '',
        tool_calls: [
          {
            id: 'edit-1',
            name: 'edit',
            args: {
              filePath: '/workspace/src/main.js',
              oldString: 'const old = 1',
              newString: 'const fresh = 2'
            }
          }
        ]
      }
    }
  ]
  renderComponent(<TrajectoryTimeline events={editEvents} />)

  // Labels are the actual argument names, not generic Before/After.
  expect(screen.getByText('oldString')).toBeVisible()
  expect(screen.getByText('newString')).toBeVisible()
  expect(screen.getByText('const old = 1')).toBeVisible()
  expect(screen.getByText('const fresh = 2')).toBeVisible()
})

test('a tool-provided diff wins over the call arguments', () => {
  const diffEvents: TrajectoryEvent[] = [
    {
      seq: 1,
      event: 'message',
      message: {
        role: 'assistant',
        id: 'assistant-diff',
        content: '',
        tool_calls: [
          {
            id: 'edit-1',
            name: 'edit',
            args: {
              filePath: '/workspace/src/main.js',
              oldString: 'const old = 1',
              newString: 'const fresh = 2'
            }
          }
        ]
      }
    },
    {
      seq: 2,
      event: 'message',
      message: {
        role: 'tool',
        id: 'tool-edit',
        name: 'edit',
        tool_call_id: 'edit-1',
        content: 'Edit applied successfully.',
        additional_kwargs: {
          diff: [
            'Index: /workspace/src/main.js',
            '--- a/src/main.js',
            '+++ b/src/main.js',
            '@@ -1 +1 @@',
            '-const old = 1',
            '+const fresh = 2'
          ].join('\n')
        }
      }
    }
  ]
  renderComponent(<TrajectoryTimeline events={diffEvents} />)

  expect(document.querySelector('[data-patch-line="add"]')).toHaveTextContent(
    '+const fresh = 2'
  )
  expect(
    document.querySelector('[data-patch-line="remove"]')
  ).toHaveTextContent('-const old = 1')
  // The real diff replaces the argument preview entirely.
  expect(screen.queryByText('oldString')).not.toBeInTheDocument()
  expect(screen.queryByText('newString')).not.toBeInTheDocument()
})

test('a real diff can switch to side-by-side', async () => {
  const user = userEvent.setup()
  const diffEvents: TrajectoryEvent[] = [
    {
      seq: 1,
      event: 'message',
      message: {
        role: 'assistant',
        id: 'assistant-diff',
        content: '',
        tool_calls: [
          {
            id: 'edit-1',
            name: 'edit',
            args: { filePath: '/workspace/src/main.js' }
          }
        ]
      }
    },
    {
      seq: 2,
      event: 'message',
      message: {
        role: 'tool',
        id: 'tool-edit',
        name: 'edit',
        tool_call_id: 'edit-1',
        content: 'Edit applied successfully.',
        additional_kwargs: {
          diff: [
            'Index: /workspace/src/main.js',
            '--- a/src/main.js',
            '+++ b/src/main.js',
            '@@ -1 +1 @@',
            '-const old = 1',
            '+const fresh = 2'
          ].join('\n')
        }
      }
    }
  ]
  renderComponent(<TrajectoryTimeline events={diffEvents} />)

  expect(document.querySelector('[data-diff-mode="unified"]')).not.toBeNull()
  await user.click(screen.getByText('Side by side'))
  expect(
    document.querySelector('[data-diff-mode="side-by-side"]')
  ).not.toBeNull()
  expect(document.querySelector('[data-diff-kind="add"]')).toHaveTextContent(
    'const fresh = 2'
  )
  // Both sides of a paired row are marked as changed, not just the row kind.
  const pairedRow = document.querySelector('[data-diff-kind="add"]')
  expect(
    pairedRow?.querySelector('.trajectory-diff-cell.old.changed')
  ).not.toBeNull()
  expect(
    pairedRow?.querySelector('.trajectory-diff-cell.new.changed')
  ).not.toBeNull()
})

test('assistant messages show model provenance before the agent name', () => {
  const modelEvents: TrajectoryEvent[] = [
    {
      seq: 1,
      event: 'message',
      message: {
        role: 'assistant',
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
        role: 'assistant',
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
  // The parsed file header is shown as a path, not as a raw patch line.
  expect(screen.getByText('src/main.js')).toBeVisible()
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
        id: 'fixture-1',
        role: 'assistant',
        content: 'Usage-bearing response.',
        usage_metadata: {
          input_tokens: 1_200,
          output_tokens: 225,
          total_tokens: 1_425,
          cache_read_input_tokens: 450,
          cache_creation_input_tokens: 24,
          reasoning_tokens: 34
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
      message: { id: 'fixture-2', role: 'tool', content: 'Unlinked result' }
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

test('reverse navigation follows the resolved branch and hides unresolved links', async () => {
  const parallel: TrajectoryEvent[] = ['left', 'right'].flatMap(
    (branch, index) => [
      {
        seq: index * 2 + 1,
        event: 'message',
        agent: branch,
        message: {
          id: `${branch}-request`,
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'same', name: 'inspect', args: {} }]
        }
      },
      {
        seq: index * 2 + 2,
        event: 'message',
        agent: branch,
        message: {
          id: `${branch}-result`,
          role: 'tool',
          content: 'Done',
          tool_call_id: 'same'
        }
      }
    ]
  )
  parallel.push({
    seq: 5,
    event: 'message',
    message: {
      id: 'unresolved',
      role: 'tool',
      content: 'Unknown',
      tool_call_id: 'missing'
    }
  })
  const { container } = renderComponent(
    <TrajectoryTimeline events={parallel} />
  )
  const left = container.querySelector(
    '#trajectory-left-request .trajectory-tool-calls-body > div'
  )!
  const right = container.querySelector(
    '#trajectory-right-request .trajectory-tool-calls-body > div'
  )!
  expect(left.id).not.toBe(right.id)
  const leftScroll = vi.fn()
  const rightScroll = vi.fn()
  Object.defineProperty(left, 'scrollIntoView', { value: leftScroll })
  Object.defineProperty(right, 'scrollIntoView', { value: rightScroll })
  const result = container.querySelector(
    '#trajectory-right-result'
  )! as HTMLElement
  await userEvent
    .setup()
    .click(within(result).getByRole('button', { name: /back to call/i }))
  expect(rightScroll).toHaveBeenCalledOnce()
  expect(leftScroll).not.toHaveBeenCalled()
  expect(
    within(
      container.querySelector('#trajectory-unresolved')! as HTMLElement
    ).queryByRole('button', { name: /back to call/i })
  ).not.toBeInTheDocument()
})

test('failed analysis displays tool errors and prompt references without raw function JSON', async () => {
  const failed = readTrajectoryJsonl(
    readFileSync('test/fixtures/trajectory-failed-analysis.jsonl', 'utf8')
  )
  const { container } = renderComponent(<TrajectoryTimeline events={failed} />)
  expect(container.textContent).not.toContain('"type": "function_call"')
  expect(screen.queryByText(/^#\d+$/)).not.toBeInTheDocument()
  expect(
    screen.getAllByRole('button', {
      name: 'Unchanged system instructions — view earlier message'
    })
  ).toHaveLength(4)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Expand all' }))
  expect(screen.getAllByText('Recorded arguments: {}')).toHaveLength(5)
  expect(screen.getAllByText('error').length).toBeGreaterThanOrEqual(5)
  expect(screen.getByText('/workspace/project/src')).toBeInTheDocument()
})
