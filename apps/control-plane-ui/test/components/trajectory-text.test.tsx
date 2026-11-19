import React from 'react'
import { screen } from '@testing-library/react'
import { userEvent, page } from 'vitest/browser'
import { expect, test, vi } from 'vitest'

import { TrajectorySection } from '../../browser/features/trajectory/TrajectorySection.js'
import { TrajectoryTimeline } from '../../browser/features/trajectory/TrajectoryTimeline.js'
import { renderComponent } from './render.js'

const source =
  '<role>Reviewer</role>\n\n<instructions>\n## Checks\n\n**Keep evidence.**\n\n`<literal/>`\n\n```xml\n<code>kept</code>\n```\n</instructions>'

test('preview renders the body and code; source retains the original text', async () => {
  const user = userEvent.setup()
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
  await user.click(page.getByText('Source', { exact: true }))
  expect(container.querySelector('pre')?.textContent).toBe(source)
  expect(screen.queryByRole('heading', { name: 'Checks' })).not.toBeInTheDocument()
  await user.click(page.getByText('Preview', { exact: true }))
  expect(screen.getByRole('heading', { name: 'Checks' })).toBeVisible()
})

test('copy retains the original text in preview and source modes', async () => {
  const user = userEvent.setup()
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  try {
    renderComponent(
      <TrajectorySection kind="message" title="Content" value={source} force={0} openedInitially />
    )
    const copyButton = screen.getByRole('button', { name: 'Copy' })
    await user.click(copyButton)
    expect(copy).toHaveBeenLastCalledWith(source)
    await user.click(page.getByText('Source', { exact: true }))
    // The confirmation label expires after two seconds; content preservation must
    // not depend on how quickly the test runner completes the mode switch.
    await user.click(copyButton)
    expect(copy).toHaveBeenCalledTimes(2)
    expect(copy).toHaveBeenLastCalledWith(source)
  } finally {
    copy.mockRestore()
  }
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
  await user.click(page.getByText('源码', { exact: true }))
  expect(container.querySelector('pre')?.textContent).toContain('<script>')
  expect(container.querySelector('script, img')).toBeNull()
})
