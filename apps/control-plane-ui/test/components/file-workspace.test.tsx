import { userEvent } from 'vitest/browser'
import React from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { FileWorkspace } from '../../browser/features/workspace/FileWorkspace.js'
import { renderComponent } from './render.js'

vi.mock('../../browser/features/workspace/CodeEditor.js', () => ({
  CodeEditor: (): null => null
}))

test.each(['new', 'rename'] as const)(
  '%s with the selected file name preserves the draft',
  async (operation) => {
    const onFilesChange = vi.fn()
    renderComponent(
      <FileWorkspace
        files={{ 'MEMORY.md': 'Keep this draft', 'notes.md': 'Notes' }}
        selectedFile="MEMORY.md"
        onSelectFile={vi.fn()}
        editable
        onFilesChange={onFilesChange}
      />
    )
    await userEvent.click(
      screen.getByRole('button', {
        name: operation === 'new' ? 'New file' : 'Rename file'
      })
    )
    const dialog = await screen.findByRole('dialog')
    await userEvent.fill(within(dialog).getByRole('textbox', { name: 'File path' }), 'MEMORY.md')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }))
    expect(onFilesChange).not.toHaveBeenCalled()
    if (operation === 'new') {
      await waitFor(() => expect(within(dialog).getByRole('alert')).toBeVisible())
    }
  }
)

test('file navigation exposes current file and directory expansion', async () => {
  renderComponent(
    <FileWorkspace
      files={{ 'notes/MEMORY.md': 'Keep this draft' }}
      selectedFile="notes/MEMORY.md"
      onSelectFile={vi.fn()}
    />
  )
  expect(screen.getByRole('button', { name: 'MEMORY.md' })).toHaveAttribute('aria-current', 'true')
  const directory = screen.getByRole('button', { name: 'notes' })
  expect(directory).toHaveAttribute('aria-expanded', 'true')
  await userEvent.click(directory)
  expect(directory).toHaveAttribute('aria-expanded', 'false')
})
