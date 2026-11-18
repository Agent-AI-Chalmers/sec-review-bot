import { userEvent } from 'vitest/browser'
import React from 'react'
import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { Memory } from '../../browser/features/memory/Memory.js'
import { api, apiPost } from '../../browser/shared/api-client.js'
import { renderComponent } from './render.js'

vi.mock('../../browser/shared/api-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../browser/shared/api-client.js')>()),
  api: vi.fn(),
  apiPost: vi.fn()
}))
vi.mock('../../browser/features/memory/MemoryOverview.js', () => ({
  MemoryOverview: (): null => null
}))
vi.mock('../../browser/features/memory/MemoryVersionHistory.js', () => ({
  MemoryVersionHistory: (): null => null
}))
vi.mock('../../browser/features/memory/MemoryObservationList.js', () => ({
  MemoryObservationList: (): null => null
}))
vi.mock('../../browser/features/workspace/FileWorkspace.js', () => ({
  FileWorkspace: ({
    files,
    onFilesChange
  }: {
    files: Record<string, string>
    onFilesChange: (files: Record<string, string>) => void
  }): React.JSX.Element => (
    <textarea
      aria-label="Memory content"
      value={files['MEMORY.md']}
      onChange={(event) => onFilesChange({ 'MEMORY.md': event.currentTarget.value })}
    />
  )
}))
afterEach(() => vi.resetAllMocks())

test.each([
  [0, false],
  [2, false],
  [2, true]
] as const)(
  'editing version %i retains its base across refresh and retries (delayed load: %s)',
  async (baseVersion, delayedLoad) => {
    // Refreshing the catalog must not authorize old editor files against a newer version.
    let currentVersion: number = baseVersion
    let treeReads = 0
    let releaseContent: (() => void) | undefined
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === '/memory/tree') {
        treeReads++
        return { version: currentVersion }
      }
      if (path === '/memory/tree/automation') {
        return { state: 'paused', version: 1 }
      }
      if (path.endsWith('/content')) {
        const version = currentVersion
        if (delayedLoad && version === baseVersion) {
          await new Promise<void>((resolve) => {
            releaseContent = resolve
          })
        }
        return { files: { 'MEMORY.md': `Version ${version}` } }
      }
      return {}
    })
    vi.mocked(apiPost).mockRejectedValue(new Error('Lost response'))
    renderComponent(<Memory />)
    const edit = await screen.findByRole('button', {
      name: 'Edit current memory'
    })
    await waitFor(() => expect(edit).toBeEnabled())
    await userEvent.click(edit)
    if (delayedLoad) {
      await waitFor(() => expect(releaseContent).toBeDefined())
      currentVersion = 3
      const readsBefore = treeReads
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await waitFor(() => expect(treeReads).toBeGreaterThan(readsBefore))
      await act(async () => {
        releaseContent!()
      })
    }
    const content = await screen.findByRole('textbox', {
      name: 'Memory content'
    })
    await userEvent.fill(content, 'First edit')
    currentVersion = 3
    const readsBefore = treeReads
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(treeReads).toBeGreaterThan(readsBefore))
    const commit = screen.getByRole('button', { name: 'Commit version' })
    await userEvent.click(commit)
    await within(screen.getByRole('dialog', { name: 'Edit memory files' })).findByText(
      'The edit could not be committed.'
    )
    expect(apiPost).toHaveBeenLastCalledWith('/memory/edit', {
      operation_id: expect.any(String) as unknown,
      expected_active_version: baseVersion,
      files: { 'MEMORY.md': 'First edit' }
    })
    const first = vi.mocked(apiPost).mock.calls[0][1]
    await userEvent.click(commit)
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2))
    expect(vi.mocked(apiPost).mock.calls[1][1]).toEqual(first)
    await waitFor(() => expect(commit).toBeEnabled())
    await userEvent.fill(content, 'Changed edit')
    await userEvent.click(commit)
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(3))
    expect(apiPost).toHaveBeenLastCalledWith('/memory/edit', {
      operation_id: expect.any(String) as unknown,
      expected_active_version: baseVersion,
      files: { 'MEMORY.md': 'Changed edit' }
    })
    expect(vi.mocked(apiPost).mock.calls[2][1]).not.toEqual(
      expect.objectContaining({
        operation_id: (first as { operation_id: string }).operation_id
      })
    )
    await waitFor(() => expect(commit).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    const discard = await screen.findByRole('dialog', {
      name: 'Discard memory changes?'
    })
    await userEvent.click(within(discard).getByRole('button', { name: 'Discard changes' }))
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Memory content' })).not.toBeInTheDocument()
    )
    await userEvent.click(edit)
    const reopened = await screen.findByRole('textbox', {
      name: 'Memory content'
    })
    expect(reopened).toHaveValue('Version 3')
    await userEvent.fill(reopened, 'First edit')
    await userEvent.click(screen.getByRole('button', { name: 'Commit version' }))
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(4))
    expect(apiPost).toHaveBeenLastCalledWith('/memory/edit', {
      operation_id: expect.any(String) as unknown,
      expected_active_version: 3,
      files: { 'MEMORY.md': 'First edit' }
    })
    expect(vi.mocked(apiPost).mock.calls[3][1]).not.toEqual(
      expect.objectContaining({
        operation_id: (first as { operation_id: string }).operation_id
      })
    )
  },
  15_000
)
