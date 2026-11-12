import {
  act,
  renderHook,
  waitFor,
  type RenderHookResult
} from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import {
  usePagedResource,
  type PagedResource
} from '../../browser/features/memory/usePagedResource.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

interface Page {
  rows: string[]
  next: string | null
}

function pagedHook(
  load: (filter: number | undefined, cursor?: string) => Promise<Page>
): RenderHookResult<PagedResource<number | undefined, string, Page>, unknown> {
  return renderHook(() =>
    usePagedResource<number | undefined, string, Page>(
      { filter: undefined, limit: 20 },
      ({ filter, trail }) => load(filter, trail.at(-1))
    )
  )
}

test('a failed filter switch keeps the displayed filter, page, and cursor together', async () => {
  // The banner, rows, and next cursor must keep describing one query; mixing the
  // new filter with the old page's cursor would skip or misattribute rows.
  const load = vi.fn((filter: number | undefined) =>
    filter === 2
      ? Promise.reject(new Error('unavailable'))
      : Promise.resolve({ rows: ['unfiltered'], next: 'unfiltered-next' })
  )
  const { result } = pagedHook(load)
  await act(async () => {
    await result.current.resource.reload()
  })
  await act(async () => {
    await result.current.openFirst({ filter: 2 })
  })

  await waitFor(() => expect(result.current.resource.error).toBeDefined())
  expect(result.current.query.filter).toBeUndefined()
  expect(result.current.resource.data?.page.rows).toEqual(['unfiltered'])

  await act(async () => {
    await result.current.openNext('unfiltered-next')
  })
  expect(load).toHaveBeenLastCalledWith(undefined, 'unfiltered-next')
})

test('previous returns along the walked cursor trail', async () => {
  const load = vi.fn((_filter: number | undefined, cursor?: string) =>
    Promise.resolve({
      rows: [cursor ?? 'first'],
      next: `${cursor ?? 'first'}+`
    })
  )
  const { result } = pagedHook(load)
  await act(async () => {
    await result.current.resource.reload()
  })
  await act(async () => {
    await result.current.openNext('first+')
  })
  await act(async () => {
    await result.current.openNext('first++')
  })
  expect(result.current.pageNumber).toBe(3)
  await act(async () => {
    await result.current.openPrevious()
  })
  expect(result.current.pageNumber).toBe(2)
  expect(result.current.resource.data?.page.rows).toEqual(['first+'])
})
