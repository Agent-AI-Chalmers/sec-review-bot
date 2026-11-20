import React from 'react'
import { expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { renderComponent } from './render.js'
import { CodeEditor } from '../../browser/features/workspace/CodeEditor.js'

test('long editor lines wrap and keyboard input updates the document', async () => {
  const changed = vi.fn()
  renderComponent(
    <div style={{ width: 260 }}>
      <CodeEditor
        value={'A repository-specific observation. '.repeat(20)}
        onChange={changed}
        ariaLabel="Memory content"
        language="text"
      />
    </div>
  )
  const editor = page.getByRole('textbox', { name: 'Memory content' })
  await expect.element(editor).toBeVisible()
  await expect
    .poll(() => editor.element().querySelector('.cm-line')?.getBoundingClientRect().height ?? 0)
    .toBeGreaterThan(40)
  expect(editor.element().scrollWidth - editor.element().clientWidth).toBeLessThanOrEqual(1)
  await userEvent.tab()
  await expect.element(editor).toHaveFocus()
  await userEvent.keyboard('Additional evidence')
  expect(changed).toHaveBeenCalled()
  expect(changed.mock.lastCall?.[0]).toContain('Additional evidence')
})
