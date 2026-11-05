import React from 'react'
import { useSearchParams } from 'react-router-dom'
import { LIST_RUN_QUERY_PARAMS } from '../../../../shared/list-run-query-params.js'

const RANGE_MINUTES: Record<string, number> = {
  '1h': 60,
  '24h': 1_440,
  '7d': 10_080
}
/** The console defaults to a scan-friendly page instead of Review Runs' larger API default.
 * Operators can still select 50 or 100 when bulk comparison matters more than page length. */
const DEFAULT_PAGE_SIZE = 20
/** sessionStorage key for the visited-page trail, so it survives navigation to a
 * run detail and back (see the cursorParents state below). */
const CURSOR_PARENTS_KEY = 'runs:cursor-parents'

interface RunsLocation {
  search: URLSearchParams
  query: string
  pageSize: number
  page: number
  updateFilter: (name: string, value: string) => void
  changePageSize: (value: string) => void
  openNextPage: (target: string | null | undefined) => void
  openPreviousPage: () => void
}

/** Own URL filters and the persisted cursor trail used by browser and page navigation. */
export function useRunsLocation(): RunsLocation {
  const [search, setSearch] = useSearchParams()
  // Mirror the latest params so two filters changed in the same tick compose instead of
  // overwriting each other. `setSearchParams`'s functional form does not queue across calls
  // (its `previous` argument is the committed location), and the render closure's `search`
  // is already stale by the second change, so this ref is the only value that reflects a
  // change made moments ago.
  const latestSearch = React.useRef(search)
  latestSearch.current = search
  // Review Runs walks pages forward by cursor only, so remember which cursor
  // each page was opened from in order to offer a previous page. Keyed by cursor
  // rather than by position, so the browser back button cannot desynchronise it.
  // Persisted in sessionStorage because navigating to a run detail unmounts this
  // component; without it, returning would reset the trail and strand the reader
  // with no Previous control (the Detail "Back to runs" link restores only the URL).
  const [cursorParents, setCursorParents] = React.useState<
    Record<string, string>
  >(() => {
    try {
      return JSON.parse(
        window.sessionStorage.getItem(CURSOR_PARENTS_KEY) ?? '{}'
      )
    } catch {
      return {}
    }
  })
  React.useEffect(() => {
    window.sessionStorage.setItem(
      CURSOR_PARENTS_KEY,
      JSON.stringify(cursorParents)
    )
  }, [cursorParents])
  const cursor = search.get('cursor') ?? ''
  const previousCursor = cursorParents[cursor]
  const requestedPageSize = Number(search.get('limit') ?? DEFAULT_PAGE_SIZE)
  const pageSize =
    Number.isSafeInteger(requestedPageSize) &&
    requestedPageSize >= 1 &&
    requestedPageSize <= 100
      ? requestedPageSize
      : DEFAULT_PAGE_SIZE
  // State the page size on every request, so the console never depends on the
  // server's own default changing underneath a bookmarked or shared link. A size
  // that the console does not offer is still honoured as an extra option.
  //
  // Copy only the parameters Review Runs declares (generated from `openapi.yaml`), never
  // the whole URL. The URL also carries UI-only state (`range`), which the API does not
  // accept; forwarding it would send Review Runs a parameter outside its contract.
  const pageQuery = new URLSearchParams()
  for (const name of LIST_RUN_QUERY_PARAMS) {
    const value = search.get(name)
    if (value !== null && value !== '') pageQuery.set(name, value)
  }
  pageQuery.set('limit', String(pageSize))
  const rangeMinutes = RANGE_MINUTES[search.get('range') ?? '']
  if (rangeMinutes !== undefined) {
    // The API takes an absolute instant, but the URL keeps the preset so a shared
    // link keeps sliding. Quantise to the minute so the request string stays
    // stable between renders instead of retriggering the loader on every one.
    const from = new Date(
      Math.floor(Date.now() / 60_000) * 60_000 - rangeMinutes * 60_000
    ).toISOString()
    pageQuery.set('from', from)
  }
  const query = pageQuery.toString()
  // Build the next params from the latest ref, write it through, then advance the ref so a
  // second change in the same tick starts from the first change's result. Without this, two
  // filters set together (as a user selecting each in turn can trigger) would leave only the
  // last one applied.
  const replaceSearch = (mutate: (next: URLSearchParams) => void): void => {
    const next = new URLSearchParams(latestSearch.current)
    mutate(next)
    latestSearch.current = next
    setSearch(next)
  }
  const updateFilter = (name: string, value: string): void => {
    setCursorParents({})
    replaceSearch((next) => {
      if (value) next.set(name, value)
      else next.delete(name)
      next.delete('cursor')
    })
  }
  const openCursor = (target: string): void => {
    replaceSearch((next) => {
      if (target) next.set('cursor', target)
      else next.delete('cursor')
    })
  }
  const openNextPage = (target: string | null | undefined): void => {
    if (target === undefined || target === null) return
    setCursorParents((parents) => ({ ...parents, [target]: cursor }))
    openCursor(target)
  }
  const openPreviousPage = (): void => {
    if (previousCursor === undefined) return
    openCursor(previousCursor)
  }
  // Mantine's pager is numbered, but the read API only walks forward and never
  // reports a total. Use the visited trail for the current position and treat
  // "there is another page" as exactly one page beyond it: `active === total` is
  // what disables the next control, and `active === 1` disables the previous one.
  const page = React.useMemo(() => {
    let number = 1
    let node = cursorParents[cursor]
    while (node !== undefined) {
      number += 1
      if (node === '') break
      node = cursorParents[node]
    }
    return number
  }, [cursorParents, cursor])
  const changePageSize = (value: string): void => {
    updateFilter('limit', value === String(DEFAULT_PAGE_SIZE) ? '' : value)
  }
  return {
    search,
    query,
    pageSize,
    page,
    updateFilter,
    changePageSize,
    openNextPage,
    openPreviousPage
  }
}
