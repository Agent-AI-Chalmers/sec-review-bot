import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { api } from '../../browser/shared/api-client.js'
import { useMemoryResources } from '../../browser/features/memory/useMemoryResources.js'

vi.mock('../../browser/shared/api-client.js', () => ({ api: vi.fn() }))
afterEach(() => vi.clearAllMocks())

test.each([
  [100, 200, 126],
  [190, 200, 201],
  [5, 200, 51],
  [5, 12, 13]
])(
  'centers version %i within history ending at %i',
  async (target, newest, before) => {
    vi.mocked(api).mockImplementation(async (url) =>
      url === '/memory/versions?limit=1'
        ? { versions: [{ version: newest }], next_before_version: null }
        : { versions: [], next_before_version: null }
    )
    const { result } = renderHook(() => useMemoryResources())
    await waitFor(() => expect(result.current.refreshing).toBe(false))
    await act(async () => {
      await result.current.showGraph(target)
    })
    expect(api).toHaveBeenCalledWith(
      `/memory/versions?limit=50&before_version=${before}`,
      expect.anything()
    )
    vi.mocked(api).mockClear()
    await act(async () => {
      await result.current.graphVersions.reload()
    })
    expect(api).toHaveBeenCalledWith(
      `/memory/versions?limit=50&before_version=${before}`,
      expect.anything()
    )
    await act(async () => {
      await result.current.showGraph()
    })
    expect(result.current.graphTarget).toBeUndefined()
    expect(api).toHaveBeenLastCalledWith(
      '/memory/versions?limit=50',
      expect.anything()
    )
  }
)
