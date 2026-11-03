import React from 'react'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { TrajectoryTimeline } from '../../browser/features/trajectory/TrajectoryTimeline.js'
import { renderComponent } from './render.js'

const source =
  '<role>Reviewer</role>\n\n<instructions>\n## Checks\n\n**Keep evidence.**\n\n`<literal/>`\n\n```xml\n<code>kept</code>\n```\n</instructions>'

test('preview renders the body and code; source and copy retain the original text', async () => {
  const user = userEvent.setup()
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const { container } = renderComponent(
    <TrajectoryTimeline
      events={[
        {
          seq: 1,
          event: 'message',
          message: { id: 'reply', role: 'assistant', content: source }
        }
      ]}
    />
  )
  expect(screen.getByRole('heading', { name: 'Checks' })).toBeVisible()
  expect(screen.getByText('Reviewer')).toBeVisible()
  expect(screen.getByText('<literal/>')).toBeVisible()
  expect(screen.getByText('<code>kept</code>')).toBeVisible()
  expect(container.textContent).not.toContain('<instructions>')
  await user.click(screen.getByRole('radio', { name: 'Source' }))
  expect(container.querySelector('pre')?.textContent).toBe(source)
  expect(
    screen.queryByRole('heading', { name: 'Checks' })
  ).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Copy' }))
  expect(copy).toHaveBeenLastCalledWith(source)
  await user.click(screen.getByRole('radio', { name: 'Preview' }))
  expect(screen.getByRole('heading', { name: 'Checks' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Copied' }))
  expect(copy).toHaveBeenLastCalledWith(source)
  copy.mockRestore()
})

test('preview uses the existing Chinese preview/source terms and never creates XML elements', async () => {
  const user = userEvent.setup()
  const { container } = renderComponent(
    <TrajectoryTimeline
      events={[
        {
          seq: 1,
          event: 'message',
          message: {
            id: 'reply',
            role: 'assistant',
            content:
              '<script>alert("example")</script>\n\n<img src="invalid" onerror="alert(1)"/>\n\n**正文**'
          }
        }
      ]}
    />,
    { language: 'zh' }
  )
  expect(screen.getByRole('radio', { name: '预览' })).toBeChecked()
  expect(container.querySelector('script, img')).toBeNull()
  expect(container.querySelector('strong')?.textContent).toBe('正文')
  await user.click(screen.getByRole('radio', { name: '源码' }))
  expect(container.querySelector('pre')?.textContent).toContain('<script>')
  expect(container.querySelector('script, img')).toBeNull()
})
