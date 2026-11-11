import React from 'react'

import { useResource, type Resource } from '../../shared/resource.js'

/** One page request: its filter, page size, and the cursors walked to reach it. */
export interface PageQuery<Filter, Cursor> {
  filter: Filter
  limit: number
  /** Cursors of the pages opened after the first; the last one is this page's. */
  trail: Cursor[]
}

export interface PagedResource<Filter, Cursor, Page> {
  resource: Resource<{ page: Page; query: PageQuery<Filter, Cursor> }>
  /** The query of the displayed page, or the initial query before any load. */
  query: PageQuery<Filter, Cursor>
  /** One-based position of the displayed page. */
  pageNumber: number
  openNext: (cursor: Cursor) => Promise<void>
  openPrevious: () => Promise<void>
  openFirst: (
    changes?: Partial<Omit<PageQuery<Filter, Cursor>, 'trail'>>
  ) => Promise<void>
}

/**
 * Page through a forward-only catalog cursor one page at a time.
 *
 * The loaded value carries the query it was read with, so the displayed filter,
 * page number, and next cursor always describe the rows on screen; a failed
 * switch keeps the previous page with its own query. A refresh reloads the
 * requested page.
 */
export function usePagedResource<Filter, Cursor, Page>(
  initial: Omit<PageQuery<Filter, Cursor>, 'trail'>,
  loadPage: (
    query: PageQuery<Filter, Cursor>,
    signal: AbortSignal
  ) => Promise<Page>
): PagedResource<Filter, Cursor, Page> {
  const requested = React.useRef<PageQuery<Filter, Cursor>>({
    ...initial,
    trail: []
  })
  const resource = useResource(async (signal) => {
    const query = requested.current
    return { page: await loadPage(query, signal), query }
  })
  const query = resource.data?.query ?? requested.current
  const open = async (next: PageQuery<Filter, Cursor>): Promise<void> => {
    requested.current = next
    await resource.reload()
  }
  return {
    resource,
    query,
    pageNumber: query.trail.length + 1,
    openNext: (cursor) => open({ ...query, trail: [...query.trail, cursor] }),
    openPrevious: async (): Promise<void> => {
      if (query.trail.length > 0)
        await open({ ...query, trail: query.trail.slice(0, -1) })
    },
    openFirst: (changes = {}) => open({ ...query, ...changes, trail: [] })
  }
}
